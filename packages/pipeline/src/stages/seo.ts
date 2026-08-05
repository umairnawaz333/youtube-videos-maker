import { z } from 'zod'
import {
  MAX_DESCRIPTION_CHARS,
  MAX_TAGS_CHARS,
  MAX_TITLE_CHARS,
  ScriptSchema,
  SeoSchema,
  STAGE_REQUIREMENTS,
  TopicSchema,
  type Stage,
  type TitleCandidate,
} from '@yt/core'
import { buildSeoMetadataPrompt, buildSeoTitlesPrompt } from './prompts/seo'

const REQUIRED_TITLES = 20

// Titles are requested in small batches rather than all 20 at once — see the prompt file's
// comment. Five per call reliably completes; twenty in one call reliably didn't (confirmed
// against a real run: three straight attempts each came back as a hallucinated
// '{"error": "..."}' refusal instead of twenty scored titles).
const TITLES_PER_BATCH = 5

// "total" is dropped from what the model must supply and computed here instead — same fix as
// TopicScout's scoring call, and for the same reason: a local model reliably gets four
// independent 0-10 scores right but cannot be trusted to also re-sum them correctly in the same
// JSON object, and the sum is trivial for us to compute correctly every time.
const TitleScoresSchema = z.object({
  curiosity: z.number().min(0).max(10),
  searchIntent: z.number().min(0).max(10),
  simplicity: z.number().min(0).max(10),
  ctr: z.number().min(0).max(10),
})

const TitleBatchSchema = z.object({
  titles: z
    .array(
      z.object({
        title: z.string().min(1),
        scores: TitleScoresSchema,
      }),
    )
    .min(1),
})

const MetadataSchema = z.object({
  description: z.string().min(1),
  tags: z.array(z.string().min(1)),
  hashtags: z.array(z.string().min(1)),
})

/** Drop tags from the end until the comma-joined total fits YouTube's limit. */
const fitTags = (tags: string[]): string[] => {
  const kept: string[] = []
  for (const tag of tags) {
    const candidate = [...kept, tag]
    if (candidate.join(',').length > MAX_TAGS_CHARS) break
    kept.push(tag)
  }
  return kept
}

export const createSeoStage = (): Stage => ({
  name: 'seo',
  requires: STAGE_REQUIREMENTS.seo,

  async run(ctx) {
    const topic = await ctx.artifacts.read('topic', TopicSchema)
    const script = await ctx.artifacts.read('script', ScriptSchema)

    const rawTitles: { title: string; scores: z.infer<typeof TitleScoresSchema> }[] = []
    for (let requested = 0; requested < REQUIRED_TITLES; requested += TITLES_PER_BATCH) {
      const count = Math.min(TITLES_PER_BATCH, REQUIRED_TITLES - requested)
      const batch = await ctx.providers.llm.json(
        buildSeoTitlesPrompt({
          topicTitle: topic.title,
          angle: topic.angle,
          count,
          // Nudges a later batch away from repeating an earlier one, on top of the dedupe
          // below that actually enforces it — see the prompt builder's comment.
          avoid: rawTitles.map((t) => t.title),
        }),
        'SeoTitlesBatch',
        (raw) => TitleBatchSchema.parse(raw),
        { temperature: ctx.config.llm.temperature, numCtx: ctx.config.llm.numCtx },
      )
      rawTitles.push(...batch.titles)
    }

    const metadata = await ctx.providers.llm.json(
      buildSeoMetadataPrompt({
        topicTitle: topic.title,
        angle: topic.angle,
        beats: script.sections.flatMap((s) => s.beats.map((b) => b.text)),
        seoRules: ctx.config.nicheConfig.seoRules,
      }),
      'SeoMetadata',
      (raw) => MetadataSchema.parse(raw),
      { temperature: ctx.config.llm.temperature, numCtx: ctx.config.llm.numCtx },
    )

    // An over-long title is unusable, so discard rather than truncate: a title cut mid-word
    // scores badly for the very reasons it was scored on. Deduped by normalized text on top of
    // that: the four batch calls are otherwise independent with no shared state between them,
    // so a near-greedy model can (and, confirmed against a real run, does) return the same
    // handful of titles across every batch. Without this, `usable.length` still hits 20 while
    // most of those 20 slots hold copies of the same few titles — `.length(20)` on the schema
    // cannot catch that, only counting DISTINCT titles can.
    const seenTitles = new Set<string>()
    const usable: TitleCandidate[] = []
    for (const t of rawTitles) {
      if (t.title.length > MAX_TITLE_CHARS) continue
      const normalized = t.title.trim().toLowerCase()
      if (seenTitles.has(normalized)) continue
      seenTitles.add(normalized)
      usable.push({
        title: t.title,
        scores: t.scores,
        total: t.scores.curiosity + t.scores.searchIntent + t.scores.simplicity + t.scores.ctr,
      })
      if (usable.length === REQUIRED_TITLES) break
    }

    if (usable.length < REQUIRED_TITLES) {
      // THROW, do not halt. This is the last of six stages: halting would discard a finished,
      // fact-checked script because the model was stingy with titles — the one thing here that
      // is cheap to re-ask for. Throwing lets the stage's own retry budget apply.
      throw new Error(
        `only ${usable.length} distinct usable titles were produced from ${rawTitles.length} raw titles ` +
          `(need ${REQUIRED_TITLES}); titles over ${MAX_TITLE_CHARS} characters and duplicates were discarded`,
      )
    }

    // Trust the scores over the stated choice, exactly as TopicScout does.
    const chosen = [...usable].sort((a, b) => b.total - a.total)[0]!

    const seo = {
      titles: usable,
      chosenTitle: chosen.title,
      description: metadata.description.slice(0, MAX_DESCRIPTION_CHARS),
      tags: fitTags(metadata.tags),
      hashtags: metadata.hashtags,
    }

    await ctx.artifacts.write('seo', SeoSchema, seo)

    ctx.log.info(`chose "${chosen.title}" (${chosen.total}/40) from ${usable.length} candidates`)
    return { status: 'done' }
  },
})
