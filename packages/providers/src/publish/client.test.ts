import { describe, expect, it, vi } from 'vitest'
import { createYoutubeClient } from './client'
import type { OAuthTokenProvider } from './oauth'

const fakeTokenProvider: OAuthTokenProvider = { getAccessToken: async () => 'access-tok' }

const metadata = { title: 'A title', description: 'A description', tags: ['a', 'b'], privacyStatus: 'unlisted' }

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers })

const emptyResponse = (status: number, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers })

/** A readChunk that slices a fixed in-memory buffer, mirroring what index.ts does over an fs handle. */
const chunkReaderFor = (buffer: Buffer) => async (start: number, length: number) => buffer.subarray(start, start + length)

describe('createYoutubeClient.uploadVideo', () => {
  it('performs a fresh upload: init, one PUT per chunk, resolves with the created video', async () => {
    const totalBytes = 25
    const buffer = Buffer.alloc(totalBytes, 7)
    const calls: { url: string; init: RequestInit }[] = []

    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (calls.length === 1) {
        expect(String(url)).toContain('uploadType=resumable')
        return emptyResponse(200, { location: 'https://upload.example/session-abc' })
      }
      const contentRange = (init.headers as Record<string, string>)['content-range']
      if (calls.length === 2) {
        expect(contentRange).toBe('bytes 0-9/25')
        return emptyResponse(308, { range: 'bytes=0-9' })
      }
      if (calls.length === 3) {
        expect(contentRange).toBe('bytes 10-19/25')
        return emptyResponse(308, { range: 'bytes=0-19' })
      }
      expect(contentRange).toBe('bytes 20-24/25')
      return jsonResponse({ id: 'vid-fresh', status: { privacyStatus: 'unlisted' } }, 200)
    }) as unknown as typeof fetch

    const onSessionStarted = vi.fn(async () => {})
    const client = createYoutubeClient({ tokenProvider: fakeTokenProvider, fetchImpl, chunkSizeBytes: 10 })

    const video = await client.uploadVideo({
      totalBytes,
      contentType: 'video/mp4',
      metadata,
      existingSession: null,
      onSessionStarted,
      readChunk: chunkReaderFor(buffer),
    })

    expect(video).toEqual({ id: 'vid-fresh', privacyStatus: 'unlisted' })
    expect(onSessionStarted).toHaveBeenCalledWith({
      uploadUrl: 'https://upload.example/session-abc',
      totalBytes: 25,
      contentType: 'video/mp4',
    })
    expect(calls).toHaveLength(4)
  })

  it('resumes an interrupted upload from the confirmed offset instead of restarting, without re-initiating a session', async () => {
    const totalBytes = 30
    const buffer = Buffer.alloc(totalBytes, 9)
    const chunkSizeBytes = 10
    const client = createYoutubeClient({
      tokenProvider: fakeTokenProvider,
      chunkSizeBytes,
      fetchImpl: vi.fn(async () => {
        throw new Error('should not be called in this test')
      }) as unknown as typeof fetch,
    })

    // --- Attempt 1: the process dies partway through the first chunk PUT. The server received
    // the bytes, but the client never saw the response (a realistic dropped-connection case).
    let attempt1Calls = 0
    const attempt1Fetch = vi.fn(async (url: string, init: RequestInit) => {
      attempt1Calls++
      if (attempt1Calls === 1) return emptyResponse(200, { location: 'https://upload.example/session-xyz' })
      expect((init.headers as Record<string, string>)['content-range']).toBe('bytes 0-9/30')
      throw new Error('simulated dropped connection')
    }) as unknown as typeof fetch

    let persistedSession: { uploadUrl: string; totalBytes: number; contentType: string } | null = null
    const clientAttempt1 = createYoutubeClient({ tokenProvider: fakeTokenProvider, fetchImpl: attempt1Fetch, chunkSizeBytes })

    await expect(
      clientAttempt1.uploadVideo({
        totalBytes,
        contentType: 'video/mp4',
        metadata,
        existingSession: null,
        onSessionStarted: async (session) => {
          persistedSession = session
        },
        readChunk: chunkReaderFor(buffer),
      }),
    ).rejects.toThrow(/simulated dropped connection/)

    expect(persistedSession).not.toBeNull()

    // --- Attempt 2: a fresh client (as if the process restarted), given the session that
    // survived on disk. It must NOT call videos.insert again, must query the real offset
    // first, and must send only the bytes YouTube doesn't have yet.
    const attempt2Fetch = vi.fn(async (url: string, init: RequestInit) => {
      // Never a resumable-session-initiating POST.
      expect(init.method).not.toBe('POST')
      const contentRange = (init.headers as Record<string, string>)['content-range']
      if (contentRange === 'bytes */30') {
        // The offset query: the server actually did receive the first chunk already.
        return emptyResponse(308, { range: 'bytes=0-9' })
      }
      if (contentRange === 'bytes 10-19/30') {
        return emptyResponse(308, { range: 'bytes=0-19' })
      }
      expect(contentRange).toBe('bytes 20-29/30')
      return jsonResponse({ id: 'vid-resumed', status: { privacyStatus: 'private' } }, 200)
    }) as unknown as typeof fetch

    const clientAttempt2 = createYoutubeClient({ tokenProvider: fakeTokenProvider, fetchImpl: attempt2Fetch, chunkSizeBytes })

    const video = await clientAttempt2.uploadVideo({
      totalBytes,
      contentType: 'video/mp4',
      metadata,
      existingSession: persistedSession,
      onSessionStarted: async () => {
        throw new Error('must not start a new session when one already exists')
      },
      readChunk: chunkReaderFor(buffer),
    })

    expect(video).toEqual({ id: 'vid-resumed', privacyStatus: 'private' })
    // Exactly one offset query + two remaining chunks: never re-sent bytes 0-9.
    expect(attempt2Fetch).toHaveBeenCalledTimes(3)
  })

  it('treats a session the server reports as already complete as done, sending no further bytes', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)['content-range']).toBe('bytes */10')
      return jsonResponse({ id: 'vid-already-done', status: { privacyStatus: 'private' } }, 200)
    }) as unknown as typeof fetch

    const client = createYoutubeClient({ tokenProvider: fakeTokenProvider, fetchImpl })
    const video = await client.uploadVideo({
      totalBytes: 10,
      contentType: 'video/mp4',
      metadata,
      existingSession: { uploadUrl: 'https://upload.example/already-done', totalBytes: 10, contentType: 'video/mp4' },
      onSessionStarted: async () => {
        throw new Error('must not be called')
      },
      readChunk: chunkReaderFor(Buffer.alloc(10)),
    })

    expect(video).toEqual({ id: 'vid-already-done', privacyStatus: 'private' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('throws a descriptive error when the init call fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 403 })) as unknown as typeof fetch
    const client = createYoutubeClient({ tokenProvider: fakeTokenProvider, fetchImpl })

    await expect(
      client.uploadVideo({
        totalBytes: 5,
        contentType: 'video/mp4',
        metadata,
        existingSession: null,
        onSessionStarted: async () => {},
        readChunk: chunkReaderFor(Buffer.alloc(5)),
      }),
    ).rejects.toThrow(/403/)
  })
})

describe('createYoutubeClient.setThumbnail', () => {
  it('POSTs raw bytes with the right content type to the thumbnails endpoint', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(String(url)).toContain('/thumbnails/set?videoId=vid-1')
      expect((init.headers as Record<string, string>)['content-type']).toBe('image/png')
      expect(init.body).toBeInstanceOf(Buffer)
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch

    const client = createYoutubeClient({ tokenProvider: fakeTokenProvider, fetchImpl })
    await client.setThumbnail({ videoId: 'vid-1', bytes: Buffer.from([1, 2, 3]), contentType: 'image/png' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('throws when the thumbnail upload fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 500 })) as unknown as typeof fetch
    const client = createYoutubeClient({ tokenProvider: fakeTokenProvider, fetchImpl })
    await expect(
      client.setThumbnail({ videoId: 'vid-1', bytes: Buffer.from([1]), contentType: 'image/png' }),
    ).rejects.toThrow(/500/)
  })
})

describe('createYoutubeClient.uploadCaptions', () => {
  it('POSTs a multipart body with JSON snippet metadata and the SRT as the media part', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(String(url)).toContain('/captions?uploadType=multipart')
      expect(init.body).toBeInstanceOf(FormData)
      const form = init.body as FormData
      const metadataPart = form.get('metadata') as Blob
      const metadataJson = JSON.parse(await metadataPart.text())
      expect(metadataJson.snippet.videoId).toBe('vid-2')
      expect(metadataJson.snippet.language).toBe('en')
      const dataPart = form.get('data') as Blob
      expect(await dataPart.text()).toBe('1\n00:00:00,000 --> 00:00:01,000\nHello\n')
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch

    const client = createYoutubeClient({ tokenProvider: fakeTokenProvider, fetchImpl })
    await client.uploadCaptions({
      videoId: 'vid-2',
      srt: '1\n00:00:00,000 --> 00:00:01,000\nHello\n',
      language: 'en',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('throws when the caption upload fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 400 })) as unknown as typeof fetch
    const client = createYoutubeClient({ tokenProvider: fakeTokenProvider, fetchImpl })
    await expect(client.uploadCaptions({ videoId: 'v', srt: 'x', language: 'en' })).rejects.toThrow(/400/)
  })
})
