import type { z } from 'zod'
import type { ModelRequirement, StageName } from './domain'
import type { FormatPreset } from './presets'
import type { AppConfig, NicheConfig } from './schemas/config'
import type { Clock, StageProviderBundle } from './providers'

export interface RunLogger {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export type ArtifactName = 'topic' | 'research' | 'script' | 'factcheck' | 'scenes' | 'seo' | 'videoSpec'

export interface ArtifactStore {
  write<T>(name: ArtifactName, schema: z.ZodType<T>, data: T): Promise<void>
  read<T>(name: ArtifactName, schema: z.ZodType<T>): Promise<T>
  exists(name: ArtifactName): Promise<boolean>
}

export interface RunPaths {
  root: string
  audio: string
  images: string
  clipsInbox: string
  clipsNormalised: string
  captions: string
  thumbnail: string
  out: string
}

/** Permanent topic dedupe, so a topic is never used twice across the channel's life. */
export interface TopicStore {
  hasUsed(key: string): Promise<boolean>
  markUsed(key: string, title: string): Promise<void>
}

export interface StoredClipRequest {
  sceneId: string
  prompt: string
  referenceImagePath: string | null
  targetSeconds: number
  fulfilledPath: string | null
  skipped: boolean
}

export interface ClipRequestStore {
  create(runId: string, requests: Omit<StoredClipRequest, 'fulfilledPath' | 'skipped'>[]): Promise<void>
  listForRun(runId: string): Promise<StoredClipRequest[]>
  markFulfilled(runId: string, sceneId: string, path: string): Promise<void>
  markSkipped(runId: string, sceneId: string): Promise<void>
}

/** AppConfig after the precedence merge, with the niche and preset already resolved. */
export interface ResolvedConfig extends AppConfig {
  nicheConfig: NicheConfig
  preset: FormatPreset
}

export interface RunContext {
  runId: string
  config: ResolvedConfig
  paths: RunPaths
  artifacts: ArtifactStore
  topics: TopicStore
  clipRequests: ClipRequestStore
  providers: StageProviderBundle
  log: RunLogger
  clock: Clock
}

export type StageOutcome =
  | { status: 'done' }
  /**
   * A stage stopping to wait for a human, NOT a failure. The reason names which kind of wait,
   * and StageRunner maps it straight onto the matching RunStatus.
   *
   * `awaiting_review` was added for the Publisher's review gate. `RUN_STATUSES` already carried
   * the value, but this type only permitted `awaiting_clips`, so the gate had no way to express
   * itself except `halted` — which StageRunner maps to `failed`. A run waiting for a human to
   * click Publish would have been recorded as a failed run, and the dashboard shows its Publish
   * button only for `awaiting_review`, so the button could never appear.
   */
  | { status: 'paused'; reason: 'awaiting_clips' | 'awaiting_review' }
  /** Quality gate and fact checker use this to stop the run with a readable reason. */
  | { status: 'halted'; reason: string }

export interface Stage {
  name: StageName
  requires: ModelRequirement
  run(ctx: RunContext): Promise<StageOutcome>
}
