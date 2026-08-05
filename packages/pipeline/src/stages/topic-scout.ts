import { z } from 'zod'
import {
  ScoredCandidateSchema,
  STAGE_REQUIREMENTS,
  TopicSchema,
  type Stage,
  type Topic,
} from '@yt/core'
import { buildTopicScoutPrompt } from './prompts/topic-scout'

const SelectionSchema = z.object({
  candidates: z.array(ScoredCandidateSchema).min(1),
  chosenKey: z.string().min(1),
  angle: z.string().min(1),
})

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

    const selection = await ctx.providers.llm.json(
      buildTopicScoutPrompt({
        candidates: fresh,
        nicheLabel: ctx.config.nicheConfig.label,
        promptGuidance: ctx.config.nicheConfig.promptGuidance,
      }),
      'TopicSelection',
      (raw) => SelectionSchema.parse(raw),
    )

    // Trust the scores over the stated choice: a local model sometimes names a key it was
    // not offered, and the highest total is a defensible answer either way.
    const offered = new Map(fresh.map((c) => [c.key, c]))
    const scored = selection.candidates.filter((c) => offered.has(c.key))
    if (scored.length === 0) {
      return {
        status: 'halted',
        reason: `the model scored none of the ${fresh.length} candidates it was given`,
      }
    }

    const best =
      scored.find((c) => c.key === selection.chosenKey) ??
      [...scored].sort((a, b) => b.total - a.total)[0]!
    const candidate = offered.get(best.key)!

    const topic: Topic = {
      key: candidate.key,
      title: candidate.title,
      source: candidate.source,
      url: candidate.url,
      angle: selection.angle,
      scores: best.scores,
      total: best.total,
    }

    await ctx.artifacts.write('topic', TopicSchema, topic)
    await ctx.topics.markUsed(topic.key, topic.title)

    ctx.log.info(`chose "${topic.title}" (score ${topic.total}/40) from ${fresh.length} fresh candidates`)
    return { status: 'done' }
  },
})
