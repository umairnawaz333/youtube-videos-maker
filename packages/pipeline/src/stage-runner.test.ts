import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG, FORMAT_PRESETS, STAGE_NAMES, type RunContext } from '@yt/core'
import { createFakeProviders, FixedClock } from '@yt/providers'
import type { Repositories } from '@yt/db'
import { EventRunLogger, ModelBroker, StageRunner, type Evictable } from '@yt/pipeline'
import { createTestDb } from '../../../test/setup/db'
import { fakeStage } from '../../../test/fixtures/stages'

let repos: Repositories
let cleanup: () => Promise<void>
let broker: ModelBroker
let unloaded: string[]

const niche = {
  id: 'space',
  label: 'Space',
  promptGuidance: 'Explain one cosmic phenomenon.',
  voice: 'male',
  styleSuffix: 'cinematic',
  music: 'ambient-drone',
  trendSources: ['wikipedia-top'],
  seoRules: 'Lead with the object.',
  monetizationRisk: 'low' as const,
}

const evictable = (id: 'llm' | 'sd'): Evictable => ({
  id,
  unload: async () => {
    unloaded.push(id)
  },
})

const context = (): RunContext =>
  ({
    runId: 'run-1',
    config: { ...DEFAULT_APP_CONFIG, nicheConfig: niche, preset: FORMAT_PRESETS.long },
    paths: {} as RunContext['paths'],
    artifacts: {} as RunContext['artifacts'],
    topics: repos.topics,
    clipRequests: repos.clips,
    providers: createFakeProviders(),
    log: new EventRunLogger('run-1', () => {}),
    clock: new FixedClock('2026-08-01T10:00:00.000Z'),
  }) as RunContext

const runner = (stages: ReturnType<typeof fakeStage>[]) =>
  new StageRunner({
    stages,
    broker,
    repos,
    clock: new FixedClock('2026-08-01T10:00:00.000Z'),
  })

beforeEach(async () => {
  const db = await createTestDb()
  repos = db.repos
  cleanup = db.cleanup
  unloaded = []
  broker = new ModelBroker([evictable('llm'), evictable('sd')])
  await repos.runs.create({
    id: 'run-1',
    niche: 'space',
    format: 'long',
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
  })
})

afterEach(async () => {
  await cleanup()
})

describe('StageRunner', () => {
  it('runs every stage in order', async () => {
    const order: string[] = []
    const stages = STAGE_NAMES.map((n) => fakeStage(n, { onRun: (name) => order.push(name) }))

    const result = await runner(stages).execute(context())

    expect(result.status).toBe('awaiting_review')
    expect(order).toEqual([...STAGE_NAMES])
  })

  it('records every stage as completed', async () => {
    await runner(STAGE_NAMES.map((n) => fakeStage(n))).execute(context())
    expect(await repos.runs.completedStages('run-1')).toEqual([...STAGE_NAMES])
  })

  it('evicts models exactly twice across a full run', async () => {
    await runner(STAGE_NAMES.map((n) => fakeStage(n))).execute(context())
    // llm evicted when the SD block begins; sd evicted by the final evictAll.
    expect(unloaded).toEqual(['llm', 'sd'])
  })

  it('retries a failing LLM stage up to its attempt limit and then succeeds', async () => {
    const stages = STAGE_NAMES.map((n) =>
      n === 'script-writer' ? fakeStage(n, { failTimes: 2 }) : fakeStage(n),
    )

    const result = await runner(stages).execute(context())

    expect(result.status).toBe('awaiting_review')
    const recorded = (await repos.runs.stages('run-1')).find((s) => s.name === 'script-writer')
    expect(recorded).toMatchObject({ status: 'done', attempts: 3 })
  })

  it('fails the run when a stage exhausts its attempts', async () => {
    const stages = STAGE_NAMES.map((n) =>
      n === 'script-writer' ? fakeStage(n, { failTimes: 99 }) : fakeStage(n),
    )

    const result = await runner(stages).execute(context())

    expect(result).toMatchObject({ status: 'failed', stoppedAt: 'script-writer' })
    expect(result.reason).toContain('script-writer failed')
    expect((await repos.runs.get('run-1'))!.status).toBe('failed')
  })

  it('does not run stages after a failure', async () => {
    const order: string[] = []
    const stages = STAGE_NAMES.map((n) =>
      n === 'researcher'
        ? fakeStage(n, { failTimes: 99, onRun: (name) => order.push(name) })
        : fakeStage(n, { onRun: (name) => order.push(name) }),
    )

    await runner(stages).execute(context())

    expect(order).not.toContain('script-writer')
  })

  it('resumes from the last completed stage instead of restarting', async () => {
    const first = STAGE_NAMES.map((n) =>
      n === 'seo' ? fakeStage(n, { failTimes: 99 }) : fakeStage(n),
    )
    await runner(first).execute(context())

    const order: string[] = []
    const second = STAGE_NAMES.map((n) => fakeStage(n, { onRun: (name) => order.push(name) }))
    const result = await runner(second).execute(context())

    expect(result.status).toBe('awaiting_review')
    expect(order[0]).toBe('seo')
    expect(order).not.toContain('topic-scout')
  })

  it('pauses the run when the clip gate asks for human input', async () => {
    const order: string[] = []
    const stages = STAGE_NAMES.map((n) =>
      n === 'clip-gate'
        ? fakeStage(n, {
            outcome: { status: 'paused', reason: 'awaiting_clips' },
            onRun: (name) => order.push(name),
          })
        : fakeStage(n, { onRun: (name) => order.push(name) }),
    )

    const result = await runner(stages).execute(context())

    expect(result).toMatchObject({ status: 'awaiting_clips', stoppedAt: 'clip-gate' })
    expect((await repos.runs.get('run-1'))!.status).toBe('awaiting_clips')
    expect(order).not.toContain('editor')
  })

  it('re-runs the paused stage on resume rather than skipping it', async () => {
    const paused = STAGE_NAMES.map((n) =>
      n === 'clip-gate'
        ? fakeStage(n, { outcome: { status: 'paused', reason: 'awaiting_clips' } })
        : fakeStage(n),
    )
    await runner(paused).execute(context())

    const order: string[] = []
    const resumed = STAGE_NAMES.map((n) => fakeStage(n, { onRun: (name) => order.push(name) }))
    const result = await runner(resumed).execute(context())

    expect(order[0]).toBe('clip-gate')
    expect(result.status).toBe('awaiting_review')
  })

  it('halts the run with a readable reason when a gate rejects it', async () => {
    const stages = STAGE_NAMES.map((n) =>
      n === 'quality-gate'
        ? fakeStage(n, { outcome: { status: 'halted', reason: 'audio and video durations differ by 9%' } })
        : fakeStage(n),
    )

    const result = await runner(stages).execute(context())

    expect(result).toMatchObject({
      status: 'failed',
      stoppedAt: 'quality-gate',
      reason: 'audio and video durations differ by 9%',
    })
  })

  it('frees all model memory even when a stage fails', async () => {
    const stages = STAGE_NAMES.map((n) =>
      n === 'illustrator' ? fakeStage(n, { failTimes: 99 }) : fakeStage(n),
    )

    await runner(stages).execute(context())

    expect(unloaded).toContain('sd')
    expect(broker.resident).toBeNull()
  })

  // Amendment (Task 8 review finding, fixed under Task 11): broker.acquire() can reject
  // — it throws for an unregistered model id, and also if the incumbent model's unload()
  // fails. execute() must record that as a stage failure and resolve with a RunResult,
  // never let the rejection escape as a thrown exception.
  it('resolves with a failed status when acquire() rejects, instead of rejecting', async () => {
    let unloadCalls = 0
    const flakyLlm: Evictable = {
      id: 'llm',
      unload: async () => {
        unloadCalls += 1
        // Fails only the eviction triggered when illustrator (the first 'sd' stage)
        // acquires and forces the resident 'llm' model out. The later evictAll() in
        // execute()'s finally block calls unload() again (current is left resident on
        // a failed eviction) — that second call must succeed so the run can actually
        // free memory, which is what lets execute() resolve cleanly.
        if (unloadCalls === 1) {
          throw new Error('llm unload failed')
        }
      },
    }
    const flakyBroker = new ModelBroker([flakyLlm, evictable('sd')])
    const stages = STAGE_NAMES.map((n) => fakeStage(n))
    const flakyRunner = new StageRunner({
      stages,
      broker: flakyBroker,
      repos,
      clock: new FixedClock('2026-08-01T10:00:00.000Z'),
    })

    const execution = flakyRunner.execute(context())

    // The explicit proof: execute() must resolve, not reject, even though acquire()
    // threw mid-run.
    await expect(execution).resolves.toMatchObject({ status: 'failed', stoppedAt: 'illustrator' })

    const result = await execution
    expect(result.reason).toContain('illustrator')

    const recorded = (await repos.runs.stages('run-1')).find((s) => s.name === 'illustrator')
    expect(recorded).toMatchObject({ status: 'failed', attempts: 1 })
    expect((await repos.runs.get('run-1'))!.status).toBe('failed')
  })
})
