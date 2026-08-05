import { z } from 'zod'
import {
  TopicScoresSchema,
  STAGE_REQUIREMENTS,
  TopicSchema,
  type ScoredCandidate,
  type Stage,
  type Topic,
  type TopicCandidate,
} from '@yt/core'
import { buildTopicScoutPrompt } from './prompts/topic-scout'

// The model only has to get the four dimension scores right; "total" is dropped from what we
// require of it and computed here instead. A real run produced all fifteen candidates with
// correct per-dimension scores but no "total" key at all on any of them — asking a local model
// to both score and then correctly sum in the same JSON object is one arithmetic step more than
// it reliably does, and the sum is trivial for us to get right every time.
const RawScoredCandidateSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1).optional(),
  scores: TopicScoresSchema,
})

// "chosen" nests the key and the angle in one object, rather than as two independent top-level
// fields, so the model cannot write a chosenKey pointing at one candidate and an angle
// describing a different one — confirmed happening for real: a response validated cleanly
// against the old two-field shape with a chosenKey that correctly named its own top-scoring
// candidate, but an angle sentence that was actually about a completely different candidate on
// the same list. Keeping the two values in one place is a real (if imperfect) guard against
// that kind of drift, on top of a schema fix alone.
const SelectionSchema = z.object({
  candidates: z.array(RawScoredCandidateSchema).min(1),
  chosen: z.object({
    key: z.string().min(1),
    angle: z.string().min(1),
  }),
})

const withComputedTotal = (candidate: z.infer<typeof RawScoredCandidateSchema>): ScoredCandidate => {
  const { curiosity, explainability, visualPotential, evergreen } = candidate.scores
  return {
    key: candidate.key,
    title: candidate.title ?? candidate.key,
    scores: candidate.scores,
    total: curiosity + explainability + visualPotential + evergreen,
  }
}

/**
 * Caps how many candidates reach the scoring prompt, picking round-robin across sources so
 * a single noisy feed cannot crowd out the rest. A real run against the unfiltered ~45-candidate
 * default (two sources' full output) produced zero usable model responses in ~15 attempts — the
 * model abandoned the task and emitted a hallucinated `{"error": ...}` refusal instead of
 * scoring. Each source's own internal order (most-viewed first, most-recent first, ...) is
 * preserved, so within a source the strongest candidates are still the ones offered.
 */
export const selectCandidatesForScoring = (
  candidates: TopicCandidate[],
  max: number,
): TopicCandidate[] => {
  if (candidates.length <= max) return candidates

  const bySource = new Map<string, TopicCandidate[]>()
  for (const candidate of candidates) {
    const queue = bySource.get(candidate.source)
    if (queue) queue.push(candidate)
    else bySource.set(candidate.source, [candidate])
  }
  const queues = [...bySource.values()]

  const picked: TopicCandidate[] = []
  for (let i = 0; picked.length < max && queues.some((q) => q.length > 0); i++) {
    const queue = queues[i % queues.length]!
    const next = queue.shift()
    if (next) picked.push(next)
  }
  return picked
}

export const createTopicScoutStage = (): Stage => ({
  name: 'topic-scout',
  requires: STAGE_REQUIREMENTS['topic-scout'],

  async run(ctx) {
    const sources = ctx.config.nicheConfig.trendSources
    ctx.log.info(`fetching topic candidates from ${sources.join(', ')}`)

    const all = await ctx.providers.trend.fetchCandidates(sources)
    if (all.length === 0) {
      return {
        status: 'halted',
        reason: `no trend source returned any candidate (tried ${sources.join(', ')})`,
      }
    }

    // Permanent dedupe: a subject is never used twice across the channel's life.
    const fresh = []
    for (const candidate of all) {
      if (!(await ctx.topics.hasUsed(candidate.key))) fresh.push(candidate)
    }
    if (fresh.length === 0) {
      return {
        status: 'halted',
        reason: `all ${all.length} candidates have already been used; nothing fresh to make a video about`,
      }
    }

    if (ctx.config.llm.topicScoutMaxCandidates < sources.length) {
      // Round-robin picks one candidate per source per pass, so a cap below the number of
      // configured sources silently drops the tail sources' candidates entirely rather than
      // merely trimming each source's list.
      ctx.log.warn(
        `topicScoutMaxCandidates (${ctx.config.llm.topicScoutMaxCandidates}) is below the ` +
          `${sources.length} configured trend sources; some sources' candidates will never reach the model`,
      )
    }

    const offeredList = selectCandidatesForScoring(fresh, ctx.config.llm.topicScoutMaxCandidates)
    if (offeredList.length < fresh.length) {
      ctx.log.info(
        `scoring ${offeredList.length} of ${fresh.length} fresh candidates ` +
          `(capped at ${ctx.config.llm.topicScoutMaxCandidates} for the model)`,
      )
    }

    const selection = await ctx.providers.llm.json(
      buildTopicScoutPrompt({
        candidates: offeredList,
        nicheLabel: ctx.config.nicheConfig.label,
        promptGuidance: ctx.config.nicheConfig.promptGuidance,
      }),
      'TopicSelection',
      (raw) => SelectionSchema.parse(raw),
      { temperature: ctx.config.llm.temperature, numCtx: ctx.config.llm.numCtx },
    )

    // Trust the scores over the stated choice: a local model sometimes names a key it was
    // not offered, and the highest total is a defensible answer either way.
    const offered = new Map(offeredList.map((c) => [c.key, c]))
    const scored = selection.candidates.filter((c) => offered.has(c.key)).map(withComputedTotal)
    if (scored.length === 0) {
      return {
        status: 'halted',
        reason: `the model scored none of the ${offeredList.length} candidates it was given`,
      }
    }

    const best =
      scored.find((c) => c.key === selection.chosen.key) ??
      [...scored].sort((a, b) => b.total - a.total)[0]!
    const candidate = offered.get(best.key)!

    const topic: Topic = {
      key: candidate.key,
      title: candidate.title,
      source: candidate.source,
      url: candidate.url,
      // The model's angle is only trustworthy when it was actually written about the
      // candidate we ended up choosing (see the schema comment above). When `chosen.key` named
      // a candidate that was never offered, we fall back to the highest score instead — and the
      // model's angle, written for its own (unusable) chosenKey, cannot be trusted for a
      // different candidate, so this generic fallback stands in rather than a mismatched claim.
      angle:
        best.key === selection.chosen.key
          ? selection.chosen.angle
          : `Follow the key facts and events behind ${candidate.title}.`,
      scores: best.scores,
      total: best.total,
    }

    await ctx.artifacts.write('topic', TopicSchema, topic)
    await ctx.topics.markUsed(topic.key, topic.title)

    ctx.log.info(`chose "${topic.title}" (score ${topic.total}/40) from ${offeredList.length} scored candidates`)
    return { status: 'done' }
  },
})
