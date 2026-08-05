import type { OAuthTokenProvider } from './oauth'
import type { UploadSession } from './session-file'

export interface VideoMetadata {
  title: string
  description: string
  tags: string[]
  privacyStatus: string
}

export interface UploadedVideo {
  id: string
  /** What YouTube actually applied. Compare against the requested privacy to detect a
   * Testing-mode OAuth app silently forcing every upload to private (spec section 14). */
  privacyStatus: string | undefined
}

export interface YoutubeClient {
  /**
   * The full resumable upload flow (Google's documented protocol): reuses `existingSession`
   * if given (querying how many bytes it already has rather than assuming), otherwise starts
   * a fresh session and hands it to `onSessionStarted` *before* sending any video bytes — that
   * ordering is what lets a crash mid-upload be resumed instead of restarted, since the caller
   * is expected to persist that session to disk synchronously inside the callback.
   */
  uploadVideo(opts: {
    totalBytes: number
    contentType: string
    metadata: VideoMetadata
    existingSession: UploadSession | null
    onSessionStarted: (session: UploadSession) => Promise<void>
    readChunk: (start: number, length: number) => Promise<Buffer>
  }): Promise<UploadedVideo>

  setThumbnail(opts: { videoId: string; bytes: Buffer; contentType: string }): Promise<void>

  uploadCaptions(opts: { videoId: string; srt: string; language: string }): Promise<void>
}

export const DEFAULT_UPLOAD_BASE = 'https://www.googleapis.com/upload'
/** Must be a multiple of 256 KiB per Google's resumable upload protocol, except the final
 * chunk of a file. 8 MiB balances request count against how much re-sending a dropped
 * connection costs on a slow home upload link. */
export const DEFAULT_CHUNK_SIZE_BYTES = 8 * 1024 * 1024

interface ChunkResult {
  done: boolean
  video?: { id: string; status?: { privacyStatus?: string } }
  /** Bytes the server confirms it has, when `done` is false. */
  receivedBytes?: number
}

/** `bytes=0-729999` -> 730000 (one past the last received byte, i.e. the next offset to send). */
const parseRangeReceivedBytes = (res: Response): number | undefined => {
  const range = res.headers.get('range')
  if (!range) return undefined
  const match = /bytes=\d+-(\d+)/.exec(range)
  return match ? Number(match[1]) + 1 : undefined
}

const describeError = async (res: Response): Promise<string> => {
  const body = await res.text().catch(() => '')
  return `HTTP ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 500)}` : ''}`
}

/** `{id, privacyStatus}` out of a completed chunk result — shared by every `uploadVideo` exit. */
const toUploadedVideo = (result: ChunkResult): UploadedVideo => ({
  id: result.video!.id,
  privacyStatus: result.video!.status?.privacyStatus,
})

export const createYoutubeClient = (opts: {
  tokenProvider: OAuthTokenProvider
  fetchImpl?: typeof fetch
  uploadBase?: string
  chunkSizeBytes?: number
  log?: (message: string) => void
}): YoutubeClient => {
  const doFetch = opts.fetchImpl ?? fetch
  const uploadBase = opts.uploadBase ?? DEFAULT_UPLOAD_BASE
  const chunkSizeBytes = opts.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES
  const log = opts.log ?? (() => {})

  const authHeader = async (): Promise<string> => `Bearer ${await opts.tokenProvider.getAccessToken()}`

  const request = async (url: string, init: RequestInit, what: string): Promise<Response> => {
    let res: Response
    try {
      res = await doFetch(url, init)
    } catch (error) {
      // A bare fetch TypeError's own `.message` is an unhelpful "fetch failed" — the useful
      // detail (ECONNREFUSED, a dropped connection mid-upload, ...) lives on `.cause`. Same
      // fix as packages/providers/src/ollama/client.ts and the image provider's client.
      const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : ''
      const detail = error instanceof Error ? `${error.message}${cause}` : String(error)
      throw new Error(`network error while ${what} (${detail})`)
    }
    return res
  }

  /** The three outcomes both `queryUploadOffset` and `putChunk` parse a response into: done
   * with the finished video resource, not-done with how many bytes the server confirms it has,
   * or an unexpected status the caller should treat as a real failure. */
  const parseChunkResponse = async (
    res: Response,
    fallbackReceivedBytes: number,
    action: string,
  ): Promise<ChunkResult> => {
    if (res.status === 200 || res.status === 201) {
      return { done: true, video: (await res.json()) as ChunkResult['video'] }
    }
    if (res.status === 308) {
      return { done: false, receivedBytes: parseRangeReceivedBytes(res) ?? fallbackReceivedBytes }
    }
    throw new Error(`unexpected response ${action}: ${await describeError(res)}`)
  }

  const initResumableSession = async (metadata: VideoMetadata, totalBytes: number, contentType: string): Promise<string> => {
    const res = await request(
      `${uploadBase}/youtube/v3/videos?uploadType=resumable&part=snippet,status`,
      {
        method: 'POST',
        headers: {
          authorization: await authHeader(),
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-type': contentType,
          'x-upload-content-length': String(totalBytes),
        },
        body: JSON.stringify({
          snippet: { title: metadata.title, description: metadata.description, tags: metadata.tags },
          status: { privacyStatus: metadata.privacyStatus },
        }),
      },
      'starting the resumable upload session',
    )
    if (!res.ok) throw new Error(`failed to start a resumable upload session: ${await describeError(res)}`)
    const location = res.headers.get('location')
    if (!location) throw new Error('YouTube accepted the upload session but returned no Location header')
    return location
  }

  const queryUploadOffset = async (uploadUrl: string, totalBytes: number): Promise<ChunkResult> => {
    const res = await request(
      uploadUrl,
      {
        method: 'PUT',
        headers: { authorization: await authHeader(), 'content-range': `bytes */${totalBytes}` },
      },
      'querying the resumable upload offset',
    )
    return parseChunkResponse(res, 0, 'querying upload offset')
  }

  const putChunk = async (uploadUrl: string, chunk: Buffer, start: number, end: number, total: number): Promise<ChunkResult> => {
    const res = await request(
      uploadUrl,
      {
        method: 'PUT',
        headers: {
          authorization: await authHeader(),
          'content-length': String(chunk.length),
          'content-range': `bytes ${start}-${end}/${total}`,
        },
        body: chunk,
      },
      `uploading bytes ${start}-${end}/${total}`,
    )
    return parseChunkResponse(res, end + 1, `uploading chunk (bytes ${start}-${end}/${total})`)
  }

  return {
    async uploadVideo({ totalBytes, contentType, metadata, existingSession, onSessionStarted, readChunk }) {
      let uploadUrl: string
      let offset = 0

      if (existingSession) {
        uploadUrl = existingSession.uploadUrl
        const status = await queryUploadOffset(uploadUrl, totalBytes)
        if (status.done) return toUploadedVideo(status)
        offset = status.receivedBytes ?? 0
        log(`resuming an interrupted upload at byte ${offset}/${totalBytes} (no new session created)`)
      } else {
        uploadUrl = await initResumableSession(metadata, totalBytes, contentType)
        await onSessionStarted({ uploadUrl, totalBytes, contentType })
      }

      while (offset < totalBytes) {
        const length = Math.min(chunkSizeBytes, totalBytes - offset)
        const chunk = await readChunk(offset, length)
        const end = offset + chunk.length - 1
        const result = await putChunk(uploadUrl, chunk, offset, end, totalBytes)
        if (result.done) return toUploadedVideo(result)
        offset = result.receivedBytes ?? end + 1
      }

      // All bytes sent without an intermediate response confirming completion (unusual, but
      // the protocol allows the final chunk's own response to be the confirmation) — ask once
      // more rather than assuming success silently.
      const final = await queryUploadOffset(uploadUrl, totalBytes)
      if (final.done) return toUploadedVideo(final)
      throw new Error('resumable upload sent every byte but YouTube never confirmed completion')
    },

    async setThumbnail({ videoId, bytes, contentType }) {
      const res = await request(
        `${uploadBase}/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`,
        {
          method: 'POST',
          headers: {
            authorization: await authHeader(),
            'content-type': contentType,
            'content-length': String(bytes.length),
          },
          body: bytes,
        },
        'uploading the thumbnail',
      )
      if (!res.ok) throw new Error(`failed to set the thumbnail for video ${videoId}: ${await describeError(res)}`)
    },

    async uploadCaptions({ videoId, srt, language }) {
      const form = new FormData()
      form.append(
        'metadata',
        new Blob([JSON.stringify({ snippet: { videoId, language, name: '', isDraft: false } })], {
          type: 'application/json; charset=UTF-8',
        }),
      )
      form.append('data', new Blob([srt], { type: 'application/octet-stream' }), 'captions.srt')

      const res = await request(
        `${uploadBase}/youtube/v3/captions?uploadType=multipart&part=snippet`,
        { method: 'POST', headers: { authorization: await authHeader() }, body: form },
        'uploading the caption track',
      )
      if (!res.ok) throw new Error(`failed to upload captions for video ${videoId}: ${await describeError(res)}`)
    },
  }
}
