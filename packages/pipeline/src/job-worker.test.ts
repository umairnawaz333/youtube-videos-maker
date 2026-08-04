import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FixedClock } from '@yt/providers'
import type { ClaimedJob, PrismaClient, Repositories } from '@yt/db'
import { JobWorker } from '@yt/pipeline'
import { createTestDb } from '../../../test/setup/db'

let repos: Repositories
let prisma: PrismaClient
let cleanup: () => Promise<void>
const clock = () => new FixedClock('2026-08-01T10:00:00.000Z')

beforeEach(async () => {
  const db = await createTestDb()
  repos = db.repos
  prisma = db.prisma
  cleanup = db.cleanup
})

afterEach(async () => {
  await cleanup()
})

describe('JobWorker', () => {
  it('reports no work when the queue is empty', async () => {
    const worker = new JobWorker({ repos, clock: clock(), handler: async () => {} })
    expect(await worker.tick()).toBe(false)
  })

  it('processes a queued job and marks it done', async () => {
    const handler = vi.fn<(job: ClaimedJob) => Promise<void>>(async () => {})
    await repos.jobs.enqueue('generate', { runId: 'run-1' }, new Date('2026-08-01T10:00:00.000Z'))

    const worker = new JobWorker({ repos, clock: clock(), handler })
    expect(await worker.tick()).toBe(true)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]![0]).toMatchObject({ type: 'generate', payload: { runId: 'run-1' } })
    expect(await worker.tick()).toBe(false)
  })

  it('processes jobs one at a time in enqueue order', async () => {
    const seen: string[] = []
    for (const id of ['a', 'b', 'c']) {
      await repos.jobs.enqueue('generate', { runId: id }, new Date('2026-08-01T10:00:00.000Z'))
    }

    const worker = new JobWorker({
      repos,
      clock: clock(),
      handler: async (job) => {
        seen.push(String(job.payload.runId))
      },
    })
    const processed = await worker.drain()

    expect(processed).toBe(3)
    expect(seen).toEqual(['a', 'b', 'c'])
  })

  it('requeues a throwing job until the attempt limit', async () => {
    await repos.jobs.enqueue('generate', { runId: 'run-1' }, new Date('2026-08-01T10:00:00.000Z'))
    const handler = vi.fn(async () => {
      throw new Error('stage exploded')
    })

    const worker = new JobWorker({ repos, clock: clock(), maxAttempts: 2, handler })
    await worker.drain()

    expect(handler).toHaveBeenCalledTimes(2)
    expect(await worker.tick()).toBe(false)
  })

  it('does not let a handler failure escape the worker', async () => {
    await repos.jobs.enqueue('generate', {}, new Date('2026-08-01T10:00:00.000Z'))
    const worker = new JobWorker({
      repos,
      clock: clock(),
      maxAttempts: 1,
      handler: async () => {
        throw new Error('boom')
      },
    })

    await expect(worker.tick()).resolves.toBe(true)
  })

  it('quarantines a job with a malformed JSON payload instead of blocking the queue', async () => {
    // enqueue() always serialises valid JSON, so the poison-pill row has to
    // be written directly via Prisma.
    await prisma.job.create({
      data: {
        type: 'generate',
        payload: '{not valid json',
        state: 'queued',
        createdAt: new Date('2026-08-01T10:00:00.000Z'),
      },
    })
    await repos.jobs.enqueue('generate', { runId: 'healthy' }, new Date('2026-08-01T10:00:01.000Z'))

    const handler = vi.fn<(job: ClaimedJob) => Promise<void>>(async () => {})
    const worker = new JobWorker({ repos, clock: clock(), handler })

    const processed = await worker.drain()

    expect(processed).toBe(1)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]![0]).toMatchObject({ payload: { runId: 'healthy' } })

    const badJob = await prisma.job.findFirst({ where: { payload: '{not valid json' } })
    expect(badJob?.state).toBe('failed')
    expect(badJob?.error).toContain('not valid JSON')
  })

  it('skips multiple consecutive malformed rows, not just the first', async () => {
    await prisma.job.create({
      data: {
        type: 'generate',
        payload: 'nope',
        state: 'queued',
        createdAt: new Date('2026-08-01T10:00:00.000Z'),
      },
    })
    await prisma.job.create({
      data: {
        type: 'generate',
        payload: '{also bad',
        state: 'queued',
        createdAt: new Date('2026-08-01T10:00:01.000Z'),
      },
    })
    await repos.jobs.enqueue('generate', { runId: 'healthy' }, new Date('2026-08-01T10:00:02.000Z'))

    const handler = vi.fn<(job: ClaimedJob) => Promise<void>>(async () => {})
    const worker = new JobWorker({ repos, clock: clock(), handler })

    const processed = await worker.drain()

    expect(processed).toBe(1)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]![0]).toMatchObject({ payload: { runId: 'healthy' } })

    const badJobs = await prisma.job.findMany({ where: { state: 'failed' } })
    expect(badJobs).toHaveLength(2)
  })

  it('does not requeue a job whose complete() call fails after the handler already succeeded', async () => {
    await repos.jobs.enqueue('generate', { runId: 'run-1' }, new Date('2026-08-01T10:00:00.000Z'))
    const handler = vi.fn<(job: ClaimedJob) => Promise<void>>(async () => {})
    const completeSpy = vi.spyOn(repos.jobs, 'complete').mockRejectedValueOnce(new Error('disk full'))

    const worker = new JobWorker({ repos, clock: clock(), handler })

    // A complete()-failure must propagate rather than being swallowed as a
    // job failure, so capture it without letting it fail this assertion —
    // the call-count check below is what actually distinguishes the fix
    // from the bug (a buggy worker would swallow this, requeue the job, and
    // call the handler again on the next tick).
    await worker.tick().catch(() => {})
    completeSpy.mockRestore()

    // If the complete() failure had been treated as a job failure, the job
    // would have been requeued and the handler would run a second time here.
    await worker.tick()

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('contains a handler that throws a non-Error string', async () => {
    await repos.jobs.enqueue('generate', {}, new Date('2026-08-01T10:00:00.000Z'))
    const worker = new JobWorker({
      repos,
      clock: clock(),
      maxAttempts: 1,
      handler: async () => {
        throw 'boom-string'
      },
    })

    await expect(worker.tick()).resolves.toBe(true)
    expect(await worker.tick()).toBe(false)
  })

  it('contains a handler that throws null', async () => {
    await repos.jobs.enqueue('generate', {}, new Date('2026-08-01T10:00:00.000Z'))
    const worker = new JobWorker({
      repos,
      clock: clock(),
      maxAttempts: 1,
      handler: async () => {
        throw null
      },
    })

    await expect(worker.tick()).resolves.toBe(true)
    expect(await worker.tick()).toBe(false)
  })
})
