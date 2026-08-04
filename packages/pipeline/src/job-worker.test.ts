import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FixedClock } from '@yt/providers'
import type { ClaimedJob, Repositories } from '@yt/db'
import { JobWorker } from '@yt/pipeline'
import { createTestDb } from '../../../test/setup/db'

let repos: Repositories
let cleanup: () => Promise<void>
const clock = () => new FixedClock('2026-08-01T10:00:00.000Z')

beforeEach(async () => {
  const db = await createTestDb()
  repos = db.repos
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
})
