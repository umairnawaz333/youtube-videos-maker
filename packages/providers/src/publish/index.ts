import fs from 'node:fs/promises'
import path from 'node:path'
import type { Clock, PublishProvider, PublishRequest } from '@yt/core'
import { createYoutubeClient, type YoutubeClient } from './client'
import { loadYoutubeCredentialsFromEnv, type GoogleOAuthCredentials } from './env-credentials'
import { createGoogleOAuthTokenProvider } from './oauth'
import { createQuotaTracker, YOUTUBE_MAX_UPLOADS_PER_DAY, type QuotaTracker } from './quota'
import { clearUploadSession, readUploadSession, writeUploadSession } from './session-file'

export { loadYoutubeCredentialsFromEnv, type GoogleOAuthCredentials } from './env-credentials'
export { YOUTUBE_DAILY_QUOTA_UNITS, YOUTUBE_MAX_UPLOADS_PER_DAY, YOUTUBE_UPLOAD_COST_UNITS } from './quota'

export interface YoutubePublishProviderOpts {
  /** Defaults to `loadYoutubeCredentialsFromEnv()` — never hardcode these. */
  credentials?: GoogleOAuthCredentials
  fetchImpl?: typeof fetch
  chunkSizeBytes?: number
  /** Where the per-day upload counter is kept. Defaults to `<storageRoot>/publish-quota.json`.
   * Ignored when `quota` is given. */
  quotaStatePath?: string
  storageRoot?: string
  /** Override the whole tracking mechanism — e.g. a database-backed one from the pipeline
   * layer, which `packages/providers` cannot depend on directly. Defaults to a JSON sidecar
   * file at `quotaStatePath`. */
  quota?: QuotaTracker
  clock?: Clock
  /** Every runtime-visible warning (Testing-mode privacy mismatch, quota near/at cap) goes
   * through this. Defaults to `console.warn` — pass `(m) => ctx.log.warn(m, { stage:
   * 'publisher' })` when wiring the real provider bundle so it lands in the run's own log. */
  log?: (message: string) => void
}

/**
 * Real `PublishProvider` (spec section 14): a resumable YouTube Data API v3 upload, then the
 * thumbnail, then the caption track, in that order — a video must exist before either of the
 * other two can be attached to it.
 *
 * Two constraints the spec calls out are surfaced here at runtime, not just documented:
 *  - Testing-mode OAuth apps force every upload to private; a mismatch between what was
 *    requested and what the API actually applied triggers a `log()` line.
 *  - An unaudited project's quota (10,000 units/day, ~1,600/upload) caps throughput at ~6
 *    uploads/day; `log()` fires once that count is reached for the day.
 */
export class YoutubePublishProvider implements PublishProvider {
  constructor(
    private readonly client: YoutubeClient,
    private readonly quota: QuotaTracker,
    private readonly log: (message: string) => void,
  ) {}

  async publish(req: PublishRequest): Promise<{ videoId: string }> {
    const stat = await fs.stat(req.videoPath)
    const totalBytes = stat.size
    const contentType = 'video/mp4'

    const existingSession = await readUploadSession(req.videoPath)
    // A session from a previous render of a *different* video (e.g. a re-run after the
    // video was regenerated) has a stale byte count — YouTube would reject bytes offset
    // against the wrong total, so treat a size mismatch as no usable session at all.
    const usableSession = existingSession && existingSession.totalBytes === totalBytes ? existingSession : null

    const fh = await fs.open(req.videoPath, 'r')
    let video: { id: string; privacyStatus: string | undefined }
    try {
      video = await this.client.uploadVideo({
        totalBytes,
        contentType,
        metadata: { title: req.title, description: req.description, tags: req.tags, privacyStatus: req.privacy },
        existingSession: usableSession,
        onSessionStarted: (session) => writeUploadSession(req.videoPath, session),
        readChunk: async (start, length) => {
          const buf = Buffer.alloc(length)
          await fh.read(buf, 0, length, start)
          return buf
        },
      })
    } finally {
      await fh.close()
    }
    await clearUploadSession(req.videoPath)

    if (video.privacyStatus && video.privacyStatus !== req.privacy) {
      this.log(
        `requested privacy '${req.privacy}' for video ${video.id} but YouTube applied ` +
          `'${video.privacyStatus}'. This is expected while the OAuth app is in Testing mode: ` +
          'every upload is forced private until the app is submitted for verification. Flip it ' +
          'manually in YouTube Studio if this run was meant to publish for real.',
      )
    }

    // Independent of each other once the video exists — read both files and fire both
    // attachment calls concurrently rather than paying for two sequential API round-trips.
    const [thumbnailBytes, srt] = await Promise.all([
      fs.readFile(req.thumbnailPath),
      fs.readFile(req.captionsPath, 'utf8'),
    ])
    await Promise.all([
      this.client.setThumbnail({ videoId: video.id, bytes: thumbnailBytes, contentType: 'image/png' }),
      // PublishRequest carries no language field (packages/core/src/providers.ts is frozen for
      // this plan) — 'en' matches the only language the MVP niches configure today.
      this.client.uploadCaptions({ videoId: video.id, srt, language: 'en' }),
    ])

    const quotaStatus = await this.quota.recordUpload()
    if (quotaStatus.nearOrOverLimit) {
      this.log(
        `${quotaStatus.uploadsToday} upload(s) today; an unaudited OAuth project's quota ` +
          `(10,000 units/day at ~1,600/upload) caps throughput at ~${YOUTUBE_MAX_UPLOADS_PER_DAY}/day. ` +
          'Further uploads today may be rejected until the quota resets at midnight UTC.',
      )
    }

    return { videoId: video.id }
  }
}

export const createYoutubePublishProvider = (opts: YoutubePublishProviderOpts = {}): PublishProvider => {
  const credentials = opts.credentials ?? loadYoutubeCredentialsFromEnv()
  const log = opts.log ?? ((message: string) => console.warn(`[publisher] ${message}`))
  // Derived once and reused for both the token provider (wants milliseconds) and the quota
  // tracker (wants a Date), rather than re-deriving "is there a clock" twice.
  const nowDate = opts.clock ? () => opts.clock!.now() : undefined

  const tokenProvider = createGoogleOAuthTokenProvider(credentials, {
    fetchImpl: opts.fetchImpl,
    now: nowDate ? () => nowDate().getTime() : undefined,
  })
  const client = createYoutubeClient({
    tokenProvider,
    fetchImpl: opts.fetchImpl,
    chunkSizeBytes: opts.chunkSizeBytes,
    log,
  })
  const quota =
    opts.quota ??
    createQuotaTracker({
      statePath: opts.quotaStatePath ?? path.join(opts.storageRoot ?? 'storage', 'publish-quota.json'),
      now: nowDate,
    })

  return new YoutubePublishProvider(client, quota, log)
}
