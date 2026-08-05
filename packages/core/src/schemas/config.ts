import { z } from 'zod'
import { SECTION_KINDS, VIDEO_FORMATS } from '../domain'

export const TREND_SOURCES = [
  'wikipedia-top',
  'hackernews',
  'arxiv',
  'reddit',
  'google-trends',
  'nasa',
] as const
export type TrendSource = (typeof TREND_SOURCES)[number]

export const ClipsConfigSchema = z.object({
  enabled: z.boolean(),
  /** 'manual' = human generates under their Google AI Pro plan. 'api' needs billing. */
  source: z.enum(['manual', 'api']),
  budget: z.object({
    shorts: z.number().int().nonnegative(),
    long: z.number().int().nonnegative(),
  }),
  /** Clips are scarce, so they are spent only on these hero sections. */
  placement: z.array(z.enum(SECTION_KINDS)).min(1),
  maxSeconds: z.number().positive(),
  /** Veo generates native audio, which would collide with the narration. */
  stripAudio: z.boolean(),
  fallback: z.literal('image'),
  waitTimeoutHours: z.number().positive(),
})
export type ClipsConfig = z.infer<typeof ClipsConfigSchema>

export const BrandCornerSchema = z.object({
  enabled: z.boolean(),
  position: z.enum(['bottom-right', 'bottom-left', 'top-right', 'top-left']),
})
export type BrandCorner = z.infer<typeof BrandCornerSchema>

export const RetryConfigSchema = z.object({
  llm: z.number().int().min(1),
  network: z.number().int().min(1),
  render: z.number().int().min(1),
  local: z.number().int().min(1),
  /**
   * Base delay before a retry, doubling each attempt. Spec section 8 promises backoff for
   * network stages; retrying a rate-limited endpoint instantly just burns the budget.
   */
  backoffMs: z.object({
    llm: z.number().int().nonnegative(),
    network: z.number().int().nonnegative(),
    render: z.number().int().nonnegative(),
    local: z.number().int().nonnegative(),
  }),
})
export type RetryConfig = z.infer<typeof RetryConfigSchema>

export const LlmConfigSchema = z.object({
  /**
   * Sampling temperature for every structured JSON call a stage makes. Ollama's own default
   * (0.8) is tuned for open-ended chat, not for reliably staying inside a JSON schema — a
   * qwen3:8b run against an unset temperature reproducibly abandoned the topic-scout task
   * and emitted a hallucinated `{"error": ...}` refusal instead of scoring its candidates.
   */
  temperature: z.number().min(0).max(2),
  /**
   * Upper bound on how many trend candidates topic-scout puts in front of the model in one
   * call. A real run against the unfiltered ~45-candidate default produced zero usable
   * responses in ~15 attempts; capping (with source diversity preserved) keeps the prompt
   * small enough for an 8B model to actually perform the scoring task.
   *
   * Floor of 5 (rather than merely positive): `selectCandidatesForScoring` round-robins one
   * candidate per source per pass, so a cap lower than the number of configured trend sources
   * silently drops the tail sources' candidates from the model's view entirely. Five covers
   * every source combination any niche configures today (`TREND_SOURCES` has six total
   * entries, but no niche config currently lists more than two).
   */
  topicScoutMaxCandidates: z.number().int().min(5),
})
export type LlmConfig = z.infer<typeof LlmConfigSchema>

export const AppConfigSchema = z.object({
  niche: z.string().min(1),
  language: z.string().min(1),
  videoType: z.enum(VIDEO_FORMATS),
  /** Target minutes for long-form; ignored for shorts, which use the preset window. */
  duration: z.number().positive(),
  voice: z.string().min(1),
  /** Optional override; when absent the format preset decides. */
  resolution: z.string().regex(/^\d+x\d+$/).optional(),
  upload: z.boolean(),
  captions: z.boolean(),
  thumbnail: z.boolean(),
  autoPublish: z.boolean(),
  clips: ClipsConfigSchema,
  brandCorner: BrandCornerSchema,
  retries: RetryConfigSchema,
  llm: LlmConfigSchema,
})
export type AppConfig = z.infer<typeof AppConfigSchema>

export const NicheConfigSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  promptGuidance: z.string().min(1),
  voice: z.string().min(1),
  /** Appended to every SD prompt so a niche has one coherent look. */
  styleSuffix: z.string().min(1),
  music: z.string().min(1),
  trendSources: z.array(z.enum(TREND_SOURCES)).min(1),
  seoRules: z.string().min(1),
  monetizationRisk: z.enum(['low', 'medium', 'high']),
})
export type NicheConfig = z.infer<typeof NicheConfigSchema>

export const DEFAULT_APP_CONFIG: AppConfig = {
  niche: 'space',
  language: 'English',
  videoType: 'long',
  duration: 8,
  voice: 'male',
  upload: true,
  captions: true,
  thumbnail: true,
  autoPublish: false,
  clips: {
    enabled: true,
    source: 'manual',
    budget: { shorts: 2, long: 6 },
    placement: ['hook', 'reveal', 'twist'],
    maxSeconds: 8,
    stripAudio: true,
    fallback: 'image',
    waitTimeoutHours: 72,
  },
  brandCorner: { enabled: true, position: 'bottom-right' },
  retries: {
    llm: 3,
    network: 3,
    render: 1,
    local: 1,
    backoffMs: { llm: 500, network: 2000, render: 0, local: 0 },
  },
  llm: {
    temperature: 0.2,
    topicScoutMaxCandidates: 15,
  },
}
