import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STAGE_NAMES } from '@yt/core'
import type { Repositories } from '@yt/db'
import { runPipeline } from '@yt/pipeline'
import { FixedClock } from '@yt/providers'
import { createTestDb } from '../setup/db'

let repos: Repositories
let cleanup: () => Promise<void>
let storageRoot: string

const configDir = path.resolve(__dirname, '../../config')

beforeEach(async () => {
  const db = await createTestDb()
  repos = db.repos
  cleanup = db.cleanup
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-e2e-'))
})

afterEach(async () => {
  await cleanup()
  await fs.rm(storageRoot, { recursive: true, force: true })
})

describe('end-to-end pipeline with fakes', () => {
  it('runs all fourteen stages and reaches review', async () => {
    const result = await runPipeline({
      runId: 'run-e2e',
      repos,
      configDir,
      storageRoot,
      request: { niche: 'space', videoType: 'shorts', clips: undefined },
      useFakes: true,
      clock: new FixedClock('2026-08-01T10:00:00.000Z'),
    })

    expect(result.status).toBe('awaiting_review')
    expect(await repos.runs.completedStages('run-e2e')).toEqual([...STAGE_NAMES])
  })

  it('creates the per-run storage layout', async () => {
    await runPipeline({
      runId: 'run-e2e',
      repos,
      configDir,
      storageRoot,
      request: { niche: 'space', videoType: 'shorts' },
      useFakes: true,
      clock: new FixedClock('2026-08-01T10:00:00.000Z'),
    })

    const root = path.join(storageRoot, 'videos', 'run-e2e')
    for (const dir of ['audio', 'images', 'captions', 'thumbnail', 'out', 'clips/inbox']) {
      expect((await fs.stat(path.join(root, dir))).isDirectory()).toBe(true)
    }
  })

  it('completes in a few seconds because no model is loaded', async () => {
    const started = process.hrtime.bigint()
    await runPipeline({
      runId: 'run-e2e',
      repos,
      configDir,
      storageRoot,
      request: { niche: 'space', videoType: 'shorts' },
      useFakes: true,
      clock: new FixedClock('2026-08-01T10:00:00.000Z'),
    })
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

    expect(elapsedMs).toBeLessThan(5000)
  })

  it('streams a log entry for every stage', async () => {
    const messages: string[] = []
    await runPipeline({
      runId: 'run-e2e',
      repos,
      configDir,
      storageRoot,
      request: { niche: 'space', videoType: 'shorts' },
      useFakes: true,
      clock: new FixedClock('2026-08-01T10:00:00.000Z'),
      onLog: (entry) => messages.push(entry.message),
    })

    for (const name of STAGE_NAMES) {
      expect(messages.some((m) => m.includes(name))).toBe(true)
    }
  })

  it('resumes a killed run from the last completed stage', async () => {
    // Simulate a run that already got through the LLM block.
    await repos.runs.create({
      id: 'run-resume',
      niche: 'space',
      format: 'shorts',
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
    })
    for (const name of ['topic-scout', 'researcher', 'script-writer'] as const) {
      await repos.runs.startStage('run-resume', name, new Date('2026-08-01T10:00:00.000Z'))
      await repos.runs.finishStage('run-resume', name, new Date('2026-08-01T10:00:01.000Z'))
    }

    const messages: string[] = []
    const result = await runPipeline({
      runId: 'run-resume',
      repos,
      configDir,
      storageRoot,
      request: { niche: 'space', videoType: 'shorts' },
      useFakes: true,
      clock: new FixedClock('2026-08-01T10:00:00.000Z'),
      onLog: (entry) => messages.push(entry.message),
    })

    expect(result.status).toBe('awaiting_review')
    expect(messages).toContain('skipping topic-scout, already completed')
    expect(messages).not.toContain('completed topic-scout')
  })

  it('defaults to a real clock so production runs get real timestamps', async () => {
    const before = Date.now()
    await runPipeline({
      runId: 'run-clock',
      repos,
      configDir,
      storageRoot,
      request: { niche: 'space', videoType: 'shorts' },
      useFakes: true,
      // deliberately no clock
    })
    const run = await repos.runs.get('run-clock')
    const createdAt = run!.createdAt.getTime()

    expect(createdAt).toBeGreaterThanOrEqual(before)
    expect(createdAt).toBeLessThanOrEqual(Date.now())
  })
})
