import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Repositories } from '@yt/db'
import { createFakeProviders } from '@yt/providers'
import { runPipeline } from '@yt/pipeline'
import { createTestDb } from '../../../test/setup/db'
import { buildNoopStages } from './testing/noop-stages'

let repos: Repositories
let cleanup: () => Promise<void>
let storageRoot: string

const configDir = path.resolve(__dirname, '../../../config')

beforeEach(async () => {
  const db = await createTestDb()
  repos = db.repos
  cleanup = db.cleanup
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-cli-'))
})

afterEach(async () => {
  await cleanup()
  await fs.rm(storageRoot, { recursive: true, force: true })
})

describe('runPipeline useFakes guards', () => {
  it('throws when useFakes is combined with explicit stages', async () => {
    await expect(
      runPipeline({
        runId: 'run-guard-stages',
        repos,
        configDir,
        storageRoot,
        request: { niche: 'space', videoType: 'shorts' },
        useFakes: true,
        stages: buildNoopStages(),
      }),
    ).rejects.toThrow(
      'runPipeline: `useFakes` cannot be combined with explicit `providers`, `stages`, or ' +
        'individual provider overrides',
    )
  })

  it('throws when useFakes is combined with explicit providers', async () => {
    await expect(
      runPipeline({
        runId: 'run-guard-providers',
        repos,
        configDir,
        storageRoot,
        request: { niche: 'space', videoType: 'shorts' },
        useFakes: true,
        providers: createFakeProviders(),
      }),
    ).rejects.toThrow(
      'runPipeline: `useFakes` cannot be combined with explicit `providers`, `stages`, or ' +
        'individual provider overrides',
    )
  })
})
