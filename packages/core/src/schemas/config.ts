import { z } from 'zod'
import { SECTION_KINDS, VIDEO_FORMATS } from '../domain'

export const TREND_SOURCES = [
  'wikipedia-top',
  'hackernews',
  'arxiv',
  'reddit',
  'google-trends',
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
})
export type RetryConfig = z.infer<typeof RetryConfigSchema>

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
  retries: { llm: 3, network: 3, render: 1, local: 1 },
}
