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
import { buildSeoPrompt } from './prompts/seo'

const REQUIRED_TITLES = 20

const DraftSchema = z.object({
  titles: z
    .array(
      z.object({
        title: z.string().min(1),
        scores: z.object({
          curiosity: z.number().min(0).max(10),
          searchIntent: z.number().min(0).max(10),
          simplicity: z.number().min(0).max(10),
          ctr: z.number().min(0).max(10),
        }),
        total: z.number().min(0).max(40),
      }),
    )
    .min(1),
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

    const draft = await ctx.providers.llm.json(
      buildSeoPrompt({
        topicTitle: topic.title,
        angle: topic.angle,
        beats: script.sections.flatMap((s) => s.beats.map((b) => b.text)),
        seoRules: ctx.config.nicheConfig.seoRules,
      }),
      'SeoDraft',
      (raw) => DraftSchema.parse(raw),
    )

    // An over-long title is unusable, so discard rather than truncate: a title cut mid-word
    // scores badly for the very reasons it was scored on.
    const usable: TitleCandidate[] = draft.titles
      .filter((t) => t.title.length <= MAX_TITLE_CHARS)
      .slice(0, REQUIRED_TITLES)

    if (usable.length < REQUIRED_TITLES) {
      // THROW, do not halt. This is the last of six stages: halting would discard a finished,
      // fact-checked script because the model was stingy with titles — the one thing here that
      // is cheap to re-ask for. Throwing lets the stage's own retry budget apply.
      throw new Error(
        `only ${usable.length} of ${draft.titles.length} titles were usable (need ${REQUIRED_TITLES}); ` +
          `titles over ${MAX_TITLE_CHARS} characters were discarded`,
      )
    }

    // Trust the scores over the stated choice, exactly as TopicScout does.
    const chosen = [...usable].sort((a, b) => b.total - a.total)[0]!

    const seo = {
      titles: usable,
      chosenTitle: chosen.title,
      description: draft.description.slice(0, MAX_DESCRIPTION_CHARS),
      tags: fitTags(draft.tags),
      hashtags: draft.hashtags,
    }

    await ctx.artifacts.write('seo', SeoSchema, seo)

    ctx.log.info(`chose "${chosen.title}" (${chosen.total}/40) from ${usable.length} candidates`)
    return { status: 'done' }
  },
})
