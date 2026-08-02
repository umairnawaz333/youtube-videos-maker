import type { TrendSource } from './schemas/config'

/** Injected everywhere instead of Date, so engine behaviour is deterministic in tests. */
export interface Clock {
  now(): Date
}

export interface LlmProvider {
  /** Free-form completion. Used for scoring and rewriting. */
  complete(prompt: string, opts?: { temperature?: number; maxTokens?: number }): Promise<string>
  /**
   * Completion constrained to a JSON shape. The adapter is responsible for retrying
   * until the response parses, so stages never see malformed JSON.
   */
  json<T>(prompt: string, schemaName: string, parse: (raw: unknown) => T): Promise<T>
  /** Releases model memory. Called by the ModelBroker, never by a stage. */
  unload(): Promise<void>
}

export interface TtsSpeakRequest {
  text: string
  voice: string
  outPath: string
}

export interface TtsSpeakResult {
  outPath: string
  durationSec: number
}

export interface TtsProvider {
  speak(req: TtsSpeakRequest): Promise<TtsSpeakResult>
}

export interface ImageRequest {
  prompt: string
  width: number
  height: number
  seed: number
  outPath: string
}

export interface ImageProvider {
  generate(req: ImageRequest): Promise<{ outPath: string }>
  unload(): Promise<void>
}

export interface ClipRequestSpec {
  sceneId: string
  prompt: string
  referenceImagePath: string | null
  targetSeconds: number
  aspectRatio: '9:16' | '16:9'
}

export interface ClipResult {
  sceneId: string
  /** Absolute path to the normalised clip, or null when the shot was skipped. */
  path: string | null
}

export interface ClipProvider {
  /**
   * Manual adapter: writes the shot list and returns 'paused' so the human can generate
   * clips under their own subscription. API adapter: generates and returns 'ready'.
   */
  request(specs: ClipRequestSpec[]): Promise<{ status: 'paused' } | { status: 'ready' }>
  /** Called on resume. Validates and normalises whatever arrived. */
  collect(specs: ClipRequestSpec[]): Promise<ClipResult[]>
}

export interface CaptionWord {
  word: string
  startSec: number
  endSec: number
}

export interface CaptionProvider {
  transcribe(audioPath: string): Promise<CaptionWord[]>
}

export interface PublishRequest {
  videoPath: string
  thumbnailPath: string
  captionsPath: string
  title: string
  description: string
  tags: string[]
  privacy: 'private' | 'unlisted' | 'public'
}

export interface PublishProvider {
  publish(req: PublishRequest): Promise<{ videoId: string }>
}

export interface TopicCandidate {
  key: string
  title: string
  source: TrendSource
  url: string | null
}

export interface TrendProvider {
  fetchCandidates(sources: readonly TrendSource[]): Promise<TopicCandidate[]>
}

export interface ProviderBundle {
  llm: LlmProvider
  tts: TtsProvider
  image: ImageProvider
  clip: ClipProvider
  caption: CaptionProvider
  publish: PublishProvider
  trend: TrendProvider
}

/**
 * Providers as a stage sees them. Eviction is the ModelBroker's job: a stage that
 * unloaded a model the broker still records as resident would cause the exact
 * thrash the broker exists to prevent, so `unload` is not reachable from here.
 */
export type StageProviderBundle = Omit<ProviderBundle, 'llm' | 'image'> & {
  llm: Omit<LlmProvider, 'unload'>
  image: Omit<ImageProvider, 'unload'>
}

/** DI tokens for the NestJS wiring introduced in Plan 4. */
export const PROVIDER_TOKENS = {
  llm: 'LLM_PROVIDER',
  tts: 'TTS_PROVIDER',
  image: 'IMAGE_PROVIDER',
  clip: 'CLIP_PROVIDER',
  caption: 'CAPTION_PROVIDER',
  publish: 'PUBLISH_PROVIDER',
  trend: 'TREND_PROVIDER',
  clock: 'CLOCK',
} as const
