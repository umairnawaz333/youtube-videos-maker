import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearUploadSession, readUploadSession, sessionFilePathFor, writeUploadSession } from './session-file'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-session-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('upload session sidecar', () => {
  it('derives a sidecar path next to the video file', () => {
    const videoPath = path.join(dir, 'out', 'video.mp4')
    expect(sessionFilePathFor(videoPath)).toBe(path.join(dir, 'out', 'video.mp4.upload-session.json'))
  })

  it('returns null when no session has been written yet', async () => {
    const videoPath = path.join(dir, 'video.mp4')
    expect(await readUploadSession(videoPath)).toBeNull()
  })

  it('round-trips a written session', async () => {
    const videoPath = path.join(dir, 'video.mp4')
    await writeUploadSession(videoPath, { uploadUrl: 'https://upload.example/session-1', totalBytes: 12345, contentType: 'video/mp4' })

    const read = await readUploadSession(videoPath)
    expect(read).toEqual({ uploadUrl: 'https://upload.example/session-1', totalBytes: 12345, contentType: 'video/mp4' })
  })

  it('clears a session so a fresh one is started next time', async () => {
    const videoPath = path.join(dir, 'video.mp4')
    await writeUploadSession(videoPath, { uploadUrl: 'https://upload.example/session-1', totalBytes: 1, contentType: 'video/mp4' })
    await clearUploadSession(videoPath)
    expect(await readUploadSession(videoPath)).toBeNull()
  })

  it('clearing a session that was never written does not throw', async () => {
    const videoPath = path.join(dir, 'never-written.mp4')
    await expect(clearUploadSession(videoPath)).resolves.toBeUndefined()
  })
})
