import fs from 'node:fs/promises'
import path from 'node:path'
import type { ClipProvider, ClipRequestSpec, ClipResult } from '@yt/core'
import { createRealFfmpegRunner, type FfmpegRunner } from './ffmpeg-runner'

export interface ManualClipProviderPaths {
  /** `clips/REQUESTS.md` — the human-readable shot list. */
  requestsFile: string
  /** `clips/inbox/` — where the owner drops `<sceneId>.mp4`. */
  inboxDir: string
  /** `clips/normalised/` — validated, fitted, re-encoded output. */
  normalisedDir: string
}

export interface ManualClipProviderConfig {
  /** `clips.maxSeconds` from config — Veo's own per-shot ceiling. */
  maxSeconds: number
  stripAudio: boolean
  /** The format preset's pixel dimensions clips are normalised to. */
  width: number
  height: number
  fps: number
}

/** Tolerance added to `maxSeconds` before a submitted clip is rejected as too long. */
const MAX_SECONDS_TOLERANCE = 0.5
/** Below this on the shorter side, a clip is rejected regardless of aspect ratio. */
const MIN_SHORT_SIDE = 720
/** Absolute width/height ratio slack before a clip is rejected as the wrong aspect ratio. */
const ASPECT_RATIO_TOLERANCE = 0.06
/** Boundary, as a fraction of the shortfall, between "slow to fit" and "hold last frame". */
const SLOW_FIT_BAND = 0.25
/** Guards against float noise flipping an exact-length clip into the slow-fit branch. */
const FIT_EPSILON = 0.05

const fileExists = async (p: string): Promise<boolean> => {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

const shotListMarkdown = (specs: ClipRequestSpec[]): string => {
  const lines = [
    '# Veo clip requests',
    '',
    'Generate each shot below in the Gemini app or Flow, using the reference image as the',
    'first frame (image-to-video). Drop the result into `clips/inbox/` named exactly as shown,',
    'then re-run the pipeline to continue. Skipping a shot falls back to its SDXL image.',
    '',
  ]
  for (const spec of specs) {
    lines.push(
      `## ${spec.sceneId}`,
      '',
      `- **File name:** \`${spec.sceneId}.mp4\``,
      `- **Prompt:** ${spec.prompt}`,
      `- **Reference image:** ${spec.referenceImagePath ?? '(none)'}`,
      `- **Aspect ratio:** ${spec.aspectRatio}`,
      `- **Target duration:** ${spec.targetSeconds}s`,
      '',
    )
  }
  return lines.join('\n')
}

const expectedRatio = (aspectRatio: ClipRequestSpec['aspectRatio']): number =>
  aspectRatio === '9:16' ? 9 / 16 : 16 / 9

/**
 * The manual `ClipProvider` adapter (spec section 11). `request` writes the shot list and
 * always pauses — a human must act under their own Google AI Pro subscription. `collect`
 * probes whatever has appeared in the inbox, rejects anything that fails validation with a
 * specific logged reason, and fits accepted clips to the scene's measured duration by
 * trimming, slowing, or holding the final frame, exactly as spec section 11 describes.
 */
export const createManualClipProvider = (
  paths: ManualClipProviderPaths,
  config: ManualClipProviderConfig,
  ffmpeg: FfmpegRunner = createRealFfmpegRunner(),
  logger: (message: string, reason: string) => void = () => {},
): ClipProvider => ({
  async request(specs) {
    await fs.mkdir(path.dirname(paths.requestsFile), { recursive: true })
    await fs.writeFile(paths.requestsFile, shotListMarkdown(specs), 'utf8')
    return { status: 'paused' }
  },

  async collect(specs: ClipRequestSpec[]): Promise<ClipResult[]> {
    return Promise.all(
      specs.map(async (spec): Promise<ClipResult> => {
        const inputPath = path.join(paths.inboxDir, `${spec.sceneId}.mp4`)
        if (!(await fileExists(inputPath))) {
          return { sceneId: spec.sceneId, path: null }
        }

        const probe = await ffmpeg.probe(inputPath)

        if (!probe.decodable) {
          logger(`clip for ${spec.sceneId} rejected`, 'undecodable: ffprobe found no readable video stream')
          return { sceneId: spec.sceneId, path: null }
        }
        if (probe.durationSec > config.maxSeconds + MAX_SECONDS_TOLERANCE) {
          logger(
            `clip for ${spec.sceneId} rejected`,
            `too long: ${probe.durationSec}s exceeds the ${config.maxSeconds}s limit`,
          )
          return { sceneId: spec.sceneId, path: null }
        }
        if (Math.min(probe.width, probe.height) < MIN_SHORT_SIDE) {
          logger(
            `clip for ${spec.sceneId} rejected`,
            `resolution below 720p: got ${probe.width}x${probe.height}`,
          )
          return { sceneId: spec.sceneId, path: null }
        }
        const actualRatio = probe.height === 0 ? 0 : probe.width / probe.height
        if (Math.abs(actualRatio - expectedRatio(spec.aspectRatio)) > ASPECT_RATIO_TOLERANCE) {
          logger(
            `clip for ${spec.sceneId} rejected`,
            `aspect ratio mismatch: expected ${spec.aspectRatio}, got ${probe.width}x${probe.height}`,
          )
          return { sceneId: spec.sceneId, path: null }
        }

        const outputPath = path.join(paths.normalisedDir, `${spec.sceneId}.mp4`)
        const filters = [
          `scale=${config.width}:${config.height}:force_original_aspect_ratio=decrease`,
          `pad=${config.width}:${config.height}:(ow-iw)/2:(oh-ih)/2`,
        ]

        const diff = spec.targetSeconds - probe.durationSec
        const trim = diff <= FIT_EPSILON
        if (!trim) {
          const shortfallRatio = diff / spec.targetSeconds
          if (shortfallRatio <= SLOW_FIT_BAND + 1e-9) {
            const factor = spec.targetSeconds / probe.durationSec
            filters.push(`setpts=${factor.toFixed(4)}*PTS`)
          } else {
            filters.push(`tpad=stop_mode=clone:stop_duration=${diff.toFixed(2)}`)
          }
        }

        const args = ['-i', inputPath, '-vf', filters.join(','), '-r', String(config.fps), '-c:v', 'libx264']
        if (config.stripAudio) args.push('-an')
        if (trim) args.push('-t', String(spec.targetSeconds))
        args.push(outputPath)

        await fs.mkdir(paths.normalisedDir, { recursive: true })
        await ffmpeg.run(args)
        return { sceneId: spec.sceneId, path: outputPath }
      }),
    )
  },
})
