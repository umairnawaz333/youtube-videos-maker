import { z } from 'zod'
import { CAMERA_MOVES, SECTION_KINDS } from '../domain'
import { TREND_SOURCES } from './config'

export const MAX_TITLE_CHARS = 100
export const MAX_DESCRIPTION_CHARS = 5000
export const MAX_TAGS_CHARS = 500
export const MAX_FAILURE_RATIO = 0.15

export const ResearchSchema = z.object({
  topicTitle: z.string().min(1),
  facts: z
    .array(
      z.object({
        text: z.string().min(1),
        sourceUrl: z.string().url(),
      }),
    )
    .min(1),
})
export type Research = z.infer<typeof ResearchSchema>

export const BeatSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  /** Engagement pacing rule from the spec: something new every 15-30 seconds. */
  targetSeconds: z.number().min(15).max(30),
})
export type Beat = z.infer<typeof BeatSchema>

export const SectionSchema = z.object({
  kind: z.enum(SECTION_KINDS),
  beats: z.array(BeatSchema).min(1),
})
export type Section = z.infer<typeof SectionSchema>

export const ScriptSchema = z
  .object({
    topicTitle: z.string().min(1),
    sections: z.array(SectionSchema).length(SECTION_KINDS.length),
  })
  .superRefine((value, ctx) => {
    const kinds = value.sections.map((s) => s.kind)
    const expected = [...SECTION_KINDS]
    if (kinds.join('|') !== expected.join('|')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sections'],
        message: `sections must be exactly ${expected.join(', ')} in that order`,
      })
    }
  })
export type Script = z.infer<typeof ScriptSchema>

export const SceneVisualSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sd-image'), prompt: z.string().min(1) }),
  z.object({
    kind: z.literal('motion-graphic'),
    variant: z.enum(['timeline', 'map', 'stat', 'quote', 'list']),
    payload: z.record(z.unknown()),
  }),
  z.object({ kind: z.literal('reuse'), sceneId: z.string().min(1) }),
  z.object({
    kind: z.literal('veo-clip'),
    prompt: z.string().min(1),
    /** Scene whose SDXL image is handed to Veo as the first frame, for style coherence. */
    referenceSceneId: z.string().min(1),
    /** Mandatory: a missing clip must degrade to an image, never block the run. */
    fallbackPrompt: z.string().min(1),
  }),
])
export type SceneVisual = z.infer<typeof SceneVisualSchema>

export const SceneSchema = z.object({
  id: z.string().min(1),
  beatId: z.string().min(1),
  text: z.string().min(1),
  visual: SceneVisualSchema,
  camera: z.enum(CAMERA_MOVES),
  /** Populated by the narrator stage once audio has been measured. */
  durationSec: z.number().positive().optional(),
})
export type Scene = z.infer<typeof SceneSchema>

export const ScenePlanSchema = z.object({
  scenes: z.array(SceneSchema).min(1),
})
export type ScenePlan = z.infer<typeof ScenePlanSchema>

export const FactCheckSchema = z.object({
  claims: z
    .array(
      z.object({
        text: z.string().min(1),
        verdict: z.enum(['supported', 'unsupported', 'contradicted']),
        // Not `.url()`: the fact-checker prompt gives the model each fact's *text* only, never
        // its sourceUrl (see ResearchSchema), so the model has no real citation to copy and can
        // only approximate one. Confirmed against a real run: requiring strict URL formatting
        // here discarded an otherwise fully-scored, valid batch of claims on ~3 of every 3
        // retry attempts purely because a handful of this cosmetic, unused-downstream field's
        // values weren't well-formed URLs — burning the stage's entire retry budget on
        // formatting noise unrelated to any actual grounding verdict.
        sourceUrl: z.string().min(1).optional(),
      }),
    )
    .min(1),
  failureRatio: z.number().min(0).max(1),
})
export type FactCheck = z.infer<typeof FactCheckSchema>

export const TitleCandidateSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_CHARS),
  scores: z.object({
    curiosity: z.number().min(0).max(10),
    searchIntent: z.number().min(0).max(10),
    simplicity: z.number().min(0).max(10),
    ctr: z.number().min(0).max(10),
  }),
  total: z.number().min(0).max(40),
})
export type TitleCandidate = z.infer<typeof TitleCandidateSchema>

export const SeoSchema = z
  .object({
    titles: z.array(TitleCandidateSchema).length(20),
    chosenTitle: z.string().min(1).max(MAX_TITLE_CHARS),
    description: z.string().max(MAX_DESCRIPTION_CHARS),
    tags: z.array(z.string().min(1)),
    hashtags: z.array(z.string().min(1)),
  })
  .superRefine((value, ctx) => {
    if (!value.titles.some((t) => t.title === value.chosenTitle)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['chosenTitle'],
        message: 'chosenTitle must be one of the generated candidates',
      })
    }
    const tagChars = value.tags.join(',').length
    if (tagChars > MAX_TAGS_CHARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tags'],
        message: `tags must total at most ${MAX_TAGS_CHARS} characters, got ${tagChars}`,
      })
    }
  })
export type Seo = z.infer<typeof SeoSchema>

export const TopicScoresSchema = z.object({
  curiosity: z.number().min(0).max(10),
  explainability: z.number().min(0).max(10),
  visualPotential: z.number().min(0).max(10),
  evergreen: z.number().min(0).max(10),
})

/** A candidate after the model has scored it, before one is chosen. */
export const ScoredCandidateSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  scores: TopicScoresSchema,
  total: z.number().min(0).max(40),
})
export type ScoredCandidate = z.infer<typeof ScoredCandidateSchema>

/** The chosen topic for a run. `key` is the permanent dedupe identity. */
export const TopicSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  source: z.enum(TREND_SOURCES),
  url: z.string().url().nullable(),
  /** The specific angle the script should take, so the writer is not left to invent one. */
  angle: z.string().min(1),
  scores: TopicScoresSchema,
  total: z.number().min(0).max(40),
})
export type Topic = z.infer<typeof TopicSchema>
