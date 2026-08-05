import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_APP_CONFIG, FORMAT_PRESETS, type ProviderBundle, type RunContext } from '@yt/core'
import { createFakeProviders, FixedClock } from '@yt/providers'
import type { Repositories } from '@yt/db'
import { EventRunLogger, FileArtifactStore, ensureRunDirs, runPaths, type LogEntry } from '@yt/pipeline'
import { createTestDb } from '../setup/db'

export interface StageHarness {
  ctx: RunContext
  /** The same provider objects the context holds, so a test can overwrite a method. */
  providers: ProviderBundle
  repos: Repositories
  logs: LogEntry[]
  cleanup: () => Promise<void>
}

const NICHE = {
  id: 'space',
  label: 'Space',
  promptGuidance: 'Explain one cosmic phenomenon through a single concrete object.',
  voice: 'male',
  styleSuffix: 'cinematic astrophotography',
  music: 'ambient-drone',
  trendSources: ['wikipedia-top', 'arxiv'],
  seoRules: 'Lead with the object, not the concept.',
  monetizationRisk: 'low',
} as const

export const makeStageContext = async (
  overrides: { videoType?: 'shorts' | 'long'; runId?: string } = {},
): Promise<StageHarness> => {
  const db = await createTestDb()
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-stage-'))
  const runId = overrides.runId ?? 'run-stage-test'
  const videoType = overrides.videoType ?? 'long'

  await db.repos.runs.create({
    id: runId,
    niche: 'space',
    format: videoType,
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
  })

  const paths = runPaths(storageRoot, runId)
  await ensureRunDirs(paths)

  const providers = createFakeProviders()
  const logs: LogEntry[] = []

  const ctx: RunContext = {
    runId,
    config: {
      ...DEFAULT_APP_CONFIG,
      videoType,
      nicheConfig: { ...NICHE, trendSources: [...NICHE.trendSources] },
      preset: FORMAT_PRESETS[videoType],
    },
    paths,
    artifacts: new FileArtifactStore(paths),
    topics: db.repos.topics,
    clipRequests: db.repos.clips,
    providers,
    log: new EventRunLogger(runId, (entry) => logs.push(entry)),
    clock: new FixedClock('2026-08-01T10:00:00.000Z'),
  }

  return {
    ctx,
    providers,
    repos: db.repos,
    logs,
    cleanup: async () => {
      await db.cleanup()
      await fs.rm(storageRoot, { recursive: true, force: true })
    },
  }
}
