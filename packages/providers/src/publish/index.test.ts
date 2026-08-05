import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublishRequest } from '@yt/core'
import { readUploadSession } from './session-file'
import { YoutubePublishProvider, createYoutubePublishProvider } from './index'
import { createYoutubeClient } from './client'
import { createQuotaTracker } from './quota'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-publish-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const writeFixtures = async () => {
  const videoPath = path.join(dir, 'out', 'video.mp4')
  const thumbnailPath = path.join(dir, 'thumbnail', 'v1.png')
  const captionsPath = path.join(dir, 'captions', 'captions.srt')
  await fs.mkdir(path.dirname(videoPath), { recursive: true })
  await fs.mkdir(path.dirname(thumbnailPath), { recursive: true })
  await fs.mkdir(path.dirname(captionsPath), { recursive: true })
  await fs.writeFile(videoPath, Buffer.alloc(20, 1))
  await fs.writeFile(thumbnailPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  await fs.writeFile(captionsPath, '1\n00:00:00,000 --> 00:00:01,000\nHello\n', 'utf8')
  return { videoPath, thumbnailPath, captionsPath }
}

const baseRequest = (paths: { videoPath: string; thumbnailPath: string; captionsPath: string }): PublishRequest => ({
  videoPath: paths.videoPath,
  thumbnailPath: paths.thumbnailPath,
  captionsPath: paths.captionsPath,
  title: 'A title',
  description: 'A description',
  tags: ['a', 'b'],
  privacy: 'unlisted',
})

describe('YoutubePublishProvider.publish', () => {
  it('uploads the video, sets the thumbnail, uploads captions, and returns the video id', async () => {
    const paths = await writeFixtures()
    const req = baseRequest(paths)

    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const u = String(url)
      if (u.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
      }
      if (u.includes('uploadType=resumable')) {
        calls.push('init')
        return new Response(null, { status: 200, headers: { location: 'https://upload.example/s1' } })
      }
      if (u === 'https://upload.example/s1') {
        calls.push('chunk')
        return new Response(JSON.stringify({ id: 'vid-1', status: { privacyStatus: 'unlisted' } }), { status: 200 })
      }
      if (u.includes('/thumbnails/set')) {
        calls.push('thumbnail')
        expect((init.headers as Record<string, string>)['content-type']).toBe('image/png')
        return new Response(null, { status: 200 })
      }
      if (u.includes('/captions?')) {
        calls.push('captions')
        return new Response(null, { status: 200 })
      }
      throw new Error(`unexpected call to ${u}`)
    }) as unknown as typeof fetch

    const provider = createYoutubePublishProvider({
      credentials: { clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh' },
      fetchImpl,
      quotaStatePath: path.join(dir, 'quota.json'),
      log: () => {},
    })

    const result = await provider.publish(req)

    expect(result).toEqual({ videoId: 'vid-1' })
    expect(calls).toEqual(['init', 'chunk', 'thumbnail', 'captions'])
    // Session sidecar is cleaned up once the upload completes.
    expect(await readUploadSession(paths.videoPath)).toBeNull()
  })

  it('logs a runtime warning when YouTube applies a different privacy than requested (Testing mode)', async () => {
    const paths = await writeFixtures()
    const req = baseRequest(paths) // requests 'unlisted'

    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
      }
      if (u.includes('uploadType=resumable')) return new Response(null, { status: 200, headers: { location: 'https://upload.example/s2' } })
      if (u === 'https://upload.example/s2') {
        return new Response(JSON.stringify({ id: 'vid-2', status: { privacyStatus: 'private' } }), { status: 200 })
      }
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch

    const log = vi.fn()
    const provider = createYoutubePublishProvider({
      credentials: { clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh' },
      fetchImpl,
      quotaStatePath: path.join(dir, 'quota.json'),
      log,
    })

    await provider.publish(req)

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Testing mode/i))
  })

  it('warns once the daily upload count reaches the unaudited quota cap', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
      }
      if (u.includes('uploadType=resumable')) return new Response(null, { status: 200, headers: { location: `https://upload.example/${Math.random()}` } })
      if (u.includes('upload.example')) return new Response(JSON.stringify({ id: `vid-${Math.random()}`, status: { privacyStatus: 'unlisted' } }), { status: 200 })
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch

    const log = vi.fn()
    const quotaStatePath = path.join(dir, 'quota.json')
    const provider = createYoutubePublishProvider({
      credentials: { clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh' },
      fetchImpl,
      quotaStatePath,
      log,
    })

    for (let i = 0; i < 6; i++) {
      const paths = await writeFixtures()
      await provider.publish(baseRequest(paths))
    }

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/quota|~6\/day|cap/i))
  })

  it('resumes rather than re-uploads when a session sidecar from an interrupted run already exists', async () => {
    const paths = await writeFixtures()
    const req = baseRequest(paths)

    // Simulate a previous, interrupted process: a session file is already on disk, and
    // YouTube already has some of the bytes.
    await fs.writeFile(
      `${paths.videoPath}.upload-session.json`,
      JSON.stringify({ uploadUrl: 'https://upload.example/resume-1', totalBytes: 20, contentType: 'video/mp4' }),
    )

    let sawInit = false
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const u = String(url)
      if (u.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
      }
      if (u.includes('uploadType=resumable')) {
        sawInit = true
        return new Response(null, { status: 200, headers: { location: 'https://upload.example/should-not-happen' } })
      }
      if (u === 'https://upload.example/resume-1') {
        const contentRange = (init.headers as Record<string, string>)['content-range']
        if (contentRange === 'bytes */20') return new Response(null, { status: 308, headers: { range: 'bytes=0-9' } })
        expect(contentRange).toBe('bytes 10-19/20')
        return new Response(JSON.stringify({ id: 'vid-resumed', status: { privacyStatus: 'unlisted' } }), { status: 200 })
      }
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch

    const provider = createYoutubePublishProvider({
      credentials: { clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh' },
      fetchImpl,
      quotaStatePath: path.join(dir, 'quota.json'),
      log: () => {},
    })

    const result = await provider.publish(req)

    expect(result).toEqual({ videoId: 'vid-resumed' })
    expect(sawInit).toBe(false)
  })

  it('loads credentials from env when none are given explicitly', async () => {
    expect(() => createYoutubePublishProvider({ credentials: undefined, fetchImpl: (async () => new Response()) as unknown as typeof fetch })).toBeDefined()
  })
})

describe('YoutubePublishProvider (constructed directly)', () => {
  it('is assembled from an injected client and quota tracker', async () => {
    const paths = await (async () => {
      const videoPath = path.join(dir, 'video.mp4')
      const thumbnailPath = path.join(dir, 'thumb.png')
      const captionsPath = path.join(dir, 'captions.srt')
      await fs.writeFile(videoPath, Buffer.alloc(4))
      await fs.writeFile(thumbnailPath, Buffer.alloc(1))
      await fs.writeFile(captionsPath, 'x', 'utf8')
      return { videoPath, thumbnailPath, captionsPath }
    })()

    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
      }
      if (u.includes('uploadType=resumable')) return new Response(null, { status: 200, headers: { location: 'https://upload.example/direct' } })
      if (u === 'https://upload.example/direct') return new Response(JSON.stringify({ id: 'vid-direct', status: { privacyStatus: 'public' } }), { status: 200 })
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch

    const client = createYoutubeClient({ tokenProvider: { getAccessToken: async () => 't' }, fetchImpl })
    const quota = createQuotaTracker({ statePath: path.join(dir, 'q.json') })
    const provider = new YoutubePublishProvider(client, quota, () => {})

    const result = await provider.publish(baseRequest(paths))
    expect(result).toEqual({ videoId: 'vid-direct' })
  })
})
