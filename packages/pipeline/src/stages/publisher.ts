import fs from 'node:fs/promises'
import path from 'node:path'
import { SeoSchema, STAGE_REQUIREMENTS, type ResolvedConfig, type Stage } from '@yt/core'
import { PublishDecisionSchema, PublishResultSchema, type PublishDecision, type PublishPrivacy } from '@yt/core/schemas/publish'

const DECISION_FILE = 'publish-decision.json'
const RESULT_FILE = 'publish-result.json'
const DEFAULT_PRIVACY: PublishPrivacy = 'private'

const TESTING_MODE_CAVEAT =
  "YouTube forces every upload to private while the OAuth app is in Testing mode, regardless of " +
  'the privacy requested here — check YouTube Studio for the actual status. An unaudited project ' +
  'also caps throughput at roughly six uploads/day (10,000-unit daily quota / ~1,600 units per upload).'

export interface PublisherStageDeps {
  /**
   * How the stage learns a human clicked Publish (spec section 9/14). Defaults to reading
   * `<run>/publish-decision.json` — see `packages/core/src/schemas/publish.ts` for the exact
   * shape and who is expected to write it (the dashboard, until it exists in this repo).
   * Overridable so tests don't need to touch the filesystem to simulate either state.
   */
  readDecision?: (root: string) => Promise<PublishDecision | null>
}

const readDecisionFile = async (root: string): Promise<PublishDecision | null> => {
  try {
    const raw = await fs.readFile(path.join(root, DECISION_FILE), 'utf8')
    return PublishDecisionSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

const fileExists = async (p: string): Promise<boolean> => {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** Resolves the thumbnail file the human picked (or the first candidate) into an absolute path. */
const resolveThumbnailPath = async (thumbnailDir: string, chosen: string | undefined): Promise<string | null> => {
  if (chosen) {
    const full = path.join(thumbnailDir, chosen)
    return (await fileExists(full)) ? full : null
  }
  let entries: string[] = []
  try {
    entries = await fs.readdir(thumbnailDir)
  } catch {
    entries = []
  }
  const candidates = entries.filter((f) => /^v\d+\.png$/i.test(f)).sort()
  return candidates.length > 0 ? path.join(thumbnailDir, candidates[0]!) : null
}

/**
 * `ResolvedConfig` (packages/core/src/schemas/config.ts) has no `privacy` field yet — adding
 * one is exactly the kind of config-schema change this plan's boundaries route back to the
 * integrator (see the plan report) rather than editing that frozen file directly. This type
 * lets the stage read it opportunistically the moment it exists, without needing a code change
 * on this side when it's added.
 */
type ConfigWithOptionalPrivacy = ResolvedConfig & { privacy?: PublishPrivacy }

/**
 * Publisher (spec section 14, last stage in the pipeline): a resumable YouTube Data API v3
 * upload of the finished video, its thumbnail, and its caption track, then privacy applied and
 * the video id recorded.
 *
 * Runs only after the human review click, unless `autoPublish` is explicitly on — see
 * `readDecision`. This check is a safety net inside the stage itself: whatever orchestrates
 * *when* this stage gets invoked (out of this plan's boundary — see the plan report) should
 * also gate on the same review click, but a stage that uploads the moment it happens to run,
 * regardless of who called it, is the one guarantee this file can make unilaterally.
 */
export const createPublisherStage = (deps: PublisherStageDeps = {}): Stage => ({
  name: 'publisher',
  requires: STAGE_REQUIREMENTS.publisher,

  async run(ctx) {
    if (!ctx.config.upload) {
      ctx.log.info('upload disabled in config, skipping publisher', { stage: 'publisher' })
      return { status: 'done' }
    }

    const readDecision = deps.readDecision ?? readDecisionFile
    const decision = await readDecision(ctx.paths.root)

    if (!decision && !ctx.config.autoPublish) {
      ctx.log.info(
        'publisher is waiting for the human review click: no publish-decision.json yet and ' +
          'autoPublish is off. The video will not be uploaded until either happens.',
        { stage: 'publisher' },
      )
      return {
        status: 'halted',
        reason:
          'awaiting the human review click: publish-decision.json is absent and autoPublish is disabled',
      }
    }

    const videoPath = path.join(ctx.paths.out, 'video.mp4')
    const captionsPath = path.join(ctx.paths.captions, 'captions.srt')

    if (!(await fileExists(videoPath))) {
      return { status: 'halted', reason: `the rendered video is missing: ${videoPath}` }
    }

    const thumbnailPath = await resolveThumbnailPath(ctx.paths.thumbnail, decision?.thumbnail)
    if (!thumbnailPath) {
      return {
        status: 'halted',
        reason: decision?.thumbnail
          ? `the chosen thumbnail '${decision.thumbnail}' was not found in ${ctx.paths.thumbnail}`
          : `no thumbnail candidate (v*.png) was found in ${ctx.paths.thumbnail}`,
      }
    }

    if (!(await fileExists(captionsPath))) {
      return { status: 'halted', reason: `captions are missing: ${captionsPath}` }
    }

    const seo = await ctx.artifacts.read('seo', SeoSchema)
    const configPrivacy = (ctx.config as ConfigWithOptionalPrivacy).privacy
    // Precedence mirrors spec section 5: per-run decision -> app config -> built-in default.
    const privacy: PublishPrivacy = decision?.privacy ?? configPrivacy ?? DEFAULT_PRIVACY

    ctx.log.warn(
      `publishing with requested privacy '${privacy}'. ${TESTING_MODE_CAVEAT}`,
      { stage: 'publisher' },
    )

    const { videoId } = await ctx.providers.publish.publish({
      videoPath,
      thumbnailPath,
      captionsPath,
      title: decision?.title ?? seo.chosenTitle,
      description: decision?.description ?? seo.description,
      tags: decision?.tags ?? seo.tags,
      privacy,
    })

    const result = PublishResultSchema.parse({
      videoId,
      publishedAt: ctx.clock.now().toISOString(),
      requestedPrivacy: privacy,
      testingModeCaveat: TESTING_MODE_CAVEAT,
    })
    await fs.writeFile(path.join(ctx.paths.root, RESULT_FILE), JSON.stringify(result, null, 2), 'utf8')

    ctx.log.info(`published video ${videoId}`, { stage: 'publisher', videoId })
    return { status: 'done' }
  },
})
