import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '../../../../test/setup/db'
import type { Repositories } from '@yt/db'

let repos: Repositories
let cleanup: () => Promise<void>

beforeEach(async () => {
  const db = await createTestDb()
  repos = db.repos
  cleanup = db.cleanup
})

afterEach(async () => {
  await cleanup()
})

const newRun = () =>
  repos.runs.create({
    id: 'run-1',
    niche: 'space',
    format: 'long',
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
  })

describe('RunRepository', () => {
  it('creates a run in the queued state', async () => {
    await newRun()
    const run = await repos.runs.get('run-1')
    expect(run).toMatchObject({ id: 'run-1', niche: 'space', format: 'long', status: 'queued' })
  })

  it('lists runs newest first, which is the order the dashboard displays them in', async () => {
    await newRun()
    await repos.runs.create({
      id: 'run-2',
      niche: 'history',
      format: 'shorts',
      createdAt: new Date('2026-08-02T10:00:00.000Z'),
    })

    const runs = await repos.runs.list()

    // run-2 is the later createdAt, so it must come first — an ascending order would still
    // return both rows and pass a length-only assertion.
    expect(runs.map((r) => r.id)).toEqual(['run-2', 'run-1'])
    expect(runs[0]).toMatchObject({ niche: 'history', format: 'shorts', status: 'queued' })
  })

  it('returns an empty list rather than throwing when no runs exist', async () => {
    expect(await repos.runs.list()).toEqual([])
  })

  it('records stage completion so runs can resume', async () => {
    await newRun()
    await repos.runs.startStage('run-1', 'topic-scout', new Date('2026-08-01T10:00:01.000Z'))
    await repos.runs.finishStage('run-1', 'topic-scout', new Date('2026-08-01T10:00:05.000Z'))

    expect(await repos.runs.completedStages('run-1')).toEqual(['topic-scout'])
  })

  it('does not report a failed stage as completed', async () => {
    await newRun()
    await repos.runs.startStage('run-1', 'researcher', new Date('2026-08-01T10:00:01.000Z'))
    await repos.runs.failStage('run-1', 'researcher', 'wikipedia unreachable', new Date('2026-08-01T10:00:02.000Z'))

    expect(await repos.runs.completedStages('run-1')).toEqual([])
    const stages = await repos.runs.stages('run-1')
    expect(stages[0]).toMatchObject({ status: 'failed', error: 'wikipedia unreachable', attempts: 1 })
  })

  it('counts attempts across retries of the same stage', async () => {
    await newRun()
    for (let i = 0; i < 3; i++) {
      await repos.runs.startStage('run-1', 'seo', new Date('2026-08-01T10:00:01.000Z'))
      await repos.runs.failStage('run-1', 'seo', 'bad json', new Date('2026-08-01T10:00:02.000Z'))
    }
    const stages = await repos.runs.stages('run-1')
    expect(stages[0]!.attempts).toBe(3)
  })

  it('stores the published video id', async () => {
    await newRun()
    await repos.runs.recordVideoId('run-1', 'abc123')
    expect((await repos.runs.get('run-1'))!.videoId).toBe('abc123')
  })

  it('moves a run into the awaiting_clips paused state', async () => {
    await newRun()
    await repos.runs.setStatus('run-1', 'awaiting_clips')
    expect((await repos.runs.get('run-1'))!.status).toBe('awaiting_clips')
  })
})

describe('TopicRepository', () => {
  it('reports a topic as unused before it is marked', async () => {
    expect(await repos.topics.hasUsed('venus-retrograde')).toBe(false)
  })

  it('permanently dedupes a used topic', async () => {
    await repos.topics.markUsed('venus-retrograde', 'Why Venus spins backwards')
    expect(await repos.topics.hasUsed('venus-retrograde')).toBe(true)
  })

  it('is idempotent when the same topic is marked twice', async () => {
    await repos.topics.markUsed('venus-retrograde', 'Why Venus spins backwards')
    await expect(
      repos.topics.markUsed('venus-retrograde', 'Why Venus spins backwards'),
    ).resolves.toBeUndefined()
  })
})

describe('ClipRepository', () => {
  beforeEach(async () => {
    await newRun()
    await repos.clips.create('run-1', [
      { sceneId: 's3', prompt: 'dust storm', referenceImagePath: '/img/s3.png', targetSeconds: 6.4 },
      { sceneId: 's9', prompt: 'city at dusk', referenceImagePath: null, targetSeconds: 7 },
    ])
  })

  it('lists requests as unfulfilled', async () => {
    const list = await repos.clips.listForRun('run-1')
    expect(list).toHaveLength(2)
    expect(list.every((c) => c.fulfilledPath === null && !c.skipped)).toBe(true)
  })

  it('marks a request fulfilled with its normalised path', async () => {
    await repos.clips.markFulfilled('run-1', 's3', '/clips/normalised/scene-003.mp4')
    const list = await repos.clips.listForRun('run-1')
    expect(list.find((c) => c.sceneId === 's3')!.fulfilledPath).toBe('/clips/normalised/scene-003.mp4')
  })

  it('marks a request skipped so the image fallback is used', async () => {
    await repos.clips.markSkipped('run-1', 's9')
    const list = await repos.clips.listForRun('run-1')
    expect(list.find((c) => c.sceneId === 's9')!.skipped).toBe(true)
  })
})

describe('JobRepository', () => {
  it('claims a queued job exactly once', async () => {
    await repos.jobs.enqueue('generate', { runId: 'run-1' }, new Date('2026-08-01T10:00:00.000Z'))
    const first = await repos.jobs.claimNext(new Date('2026-08-01T10:00:01.000Z'))
    const second = await repos.jobs.claimNext(new Date('2026-08-01T10:00:02.000Z'))

    expect(first).toMatchObject({ type: 'generate', payload: { runId: 'run-1' } })
    expect(second).toBeNull()
  })

  it('requeues a failed job until the attempt limit, then fails it', async () => {
    await repos.jobs.enqueue('generate', { runId: 'run-1' }, new Date('2026-08-01T10:00:00.000Z'))

    const job = await repos.jobs.claimNext(new Date('2026-08-01T10:00:01.000Z'))
    await repos.jobs.fail(job!.id, 'boom', 2, new Date('2026-08-01T10:00:02.000Z'))
    const retry = await repos.jobs.claimNext(new Date('2026-08-01T10:00:03.000Z'))
    expect(retry?.id).toBe(job!.id)

    await repos.jobs.fail(retry!.id, 'boom again', 2, new Date('2026-08-01T10:00:04.000Z'))
    expect(await repos.jobs.claimNext(new Date('2026-08-01T10:00:05.000Z'))).toBeNull()
  })

  it('does not requeue a completed job', async () => {
    await repos.jobs.enqueue('generate', { runId: 'run-1' }, new Date('2026-08-01T10:00:00.000Z'))
    const job = await repos.jobs.claimNext(new Date('2026-08-01T10:00:01.000Z'))
    await repos.jobs.complete(job!.id, new Date('2026-08-01T10:00:02.000Z'))
    expect(await repos.jobs.claimNext(new Date('2026-08-01T10:00:03.000Z'))).toBeNull()
  })
})
