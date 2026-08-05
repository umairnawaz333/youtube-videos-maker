import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createQuotaTracker, YOUTUBE_DAILY_QUOTA_UNITS, YOUTUBE_UPLOAD_COST_UNITS } from './quota'

let dir: string
let statePath: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-quota-'))
  statePath = path.join(dir, 'publish-quota.json')
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('createQuotaTracker', () => {
  it('reports the max uploads/day derived from the real API constants', () => {
    expect(YOUTUBE_UPLOAD_COST_UNITS).toBe(1600)
    expect(YOUTUBE_DAILY_QUOTA_UNITS).toBe(10_000)
  })

  it('starts a fresh day at zero uploads and does not warn', async () => {
    const tracker = createQuotaTracker({ statePath, now: () => new Date('2026-08-05T10:00:00.000Z') })
    const status = await tracker.recordUpload()
    expect(status.uploadsToday).toBe(1)
    expect(status.nearOrOverLimit).toBe(false)
  })

  it('accumulates uploads across calls on the same day', async () => {
    const tracker = createQuotaTracker({ statePath, now: () => new Date('2026-08-05T10:00:00.000Z') })
    await tracker.recordUpload()
    await tracker.recordUpload()
    const status = await tracker.recordUpload()
    expect(status.uploadsToday).toBe(3)
  })

  it('resets the counter on a new calendar day', async () => {
    let now = new Date('2026-08-05T23:59:00.000Z')
    const tracker = createQuotaTracker({ statePath, now: () => now })
    await tracker.recordUpload()
    await tracker.recordUpload()
    now = new Date('2026-08-06T00:05:00.000Z')
    const status = await tracker.recordUpload()
    expect(status.uploadsToday).toBe(1)
  })

  it('flags nearOrOverLimit once the unaudited daily cap (~6 uploads) is reached', async () => {
    const tracker = createQuotaTracker({ statePath, now: () => new Date('2026-08-05T10:00:00.000Z') })
    let status
    for (let i = 0; i < 6; i++) status = await tracker.recordUpload()
    expect(status!.uploadsToday).toBe(6)
    expect(status!.nearOrOverLimit).toBe(true)
  })

  it('persists state across separate tracker instances (survives a process restart)', async () => {
    const now = () => new Date('2026-08-05T10:00:00.000Z')
    await createQuotaTracker({ statePath, now }).recordUpload()
    const second = createQuotaTracker({ statePath, now })
    const status = await second.recordUpload()
    expect(status.uploadsToday).toBe(2)
  })
})
