import { describe, expect, it, vi } from 'vitest'
import type { Repositories } from '@yt/db'
import { publishRun } from '../publish'

const fakeRepos = (run: Awaited<ReturnType<Repositories['runs']['get']>>): Repositories =>
  ({
    runs: { get: vi.fn().mockResolvedValue(run) },
  }) as unknown as Repositories

describe('publishRun', () => {
  it('refuses to publish a run that does not exist', async () => {
    const result = await publishRun(fakeRepos(null), 'run-missing')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('not found')
  })

  it('refuses to publish a run that has not reached the review gate', async () => {
    const run = {
      id: 'run-1',
      niche: 'space',
      format: 'long' as const,
      status: 'running' as const,
      videoId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const result = await publishRun(fakeRepos(run), 'run-1')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('running')
  })

  it('is an honest, clearly-marked seam once a run is ready — it does not fake success', async () => {
    const run = {
      id: 'run-1',
      niche: 'space',
      format: 'long' as const,
      status: 'awaiting_review' as const,
      videoId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const result = await publishRun(fakeRepos(run), 'run-1')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('not implemented yet')
    expect(result.message).toContain('run-1')
  })
})
