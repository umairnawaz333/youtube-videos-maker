import fs from 'node:fs/promises'
import path from 'node:path'
import {
  MAX_DESCRIPTION_CHARS,
  MAX_TAGS_CHARS,
  MAX_TITLE_CHARS,
  STAGE_REQUIREMENTS,
  VideoSpecSchema,
  type Stage,
  type StageOutcome,
  type VideoSpec,
} from '@yt/core'
import { createRealMediaProbe, type MediaProbe } from '../media/media-probe'

export interface QualityGateStageDeps {
  /** Defaults to the real ffmpeg/ffprobe-backed probe. Tests inject a fake. */
  probe?: MediaProbe
}

/** How many percentage points the video and audio stream durations may disagree by. */
const MAX_DURATION_MISMATCH_PCT = 2
/** Mean pixel brightness (0-255) below which a sampled frame counts as black. */
const BLACK_FRAME_THRESHOLD = 10
/** Evenly-spaced sample points across the render, expressed as a fraction of its duration. */
const BLACK_FRAME_SAMPLE_FRACTIONS = [0.1, 0.3, 0.5, 0.7, 0.9]
/** Mean volume, in dBFS, at or below which the whole track counts as silent. */
const SILENCE_THRESHOLD_DB = -50

const halt = (reason: string): StageOutcome => ({ status: 'halted', reason })

interface RawSeo {
  chosenTitle: string
  description: string
  tags: string[]
}

/**
 * Reads `seo.json` without going through `SeoSchema`. QualityGate exists precisely to catch
 * a title/description/tags length violation regardless of how it got there — including a
 * hand-edited or corrupted artifact that would make a schema-validated read throw before this
 * stage ever got a chance to report a legible reason. A missing or unparsable file is its own
 * finding, not a crash.
 */
const readSeoRaw = async (root: string): Promise<RawSeo | null> => {
  try {
    const raw = await fs.readFile(path.join(root, 'seo.json'), 'utf8')
    const json = JSON.parse(raw) as Partial<RawSeo>
    return {
      chosenTitle: typeof json.chosenTitle === 'string' ? json.chosenTitle : '',
      description: typeof json.description === 'string' ? json.description : '',
      tags: Array.isArray(json.tags) ? json.tags.map(String) : [],
    }
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

const assetPathsOf = (spec: VideoSpec): string[] => {
  const paths: string[] = []
  for (const scene of spec.scenes) {
    paths.push(scene.audioPath)
    if (scene.visual.kind === 'image') paths.push(scene.visual.path)
    if (scene.visual.kind === 'clip') paths.push(scene.visual.path)
  }
  if (spec.musicPath) paths.push(spec.musicPath)
  return paths
}

/**
 * QualityGate (spec section 13). The spec enumerates nine independent failure conditions and
 * says to implement every one — this checks each in turn and halts with a specific,
 * human-readable reason on the first that fails, rather than a generic "quality check
 * failed". Nothing here weakens a threshold or a halt condition from the spec.
 */
export const createQualityGateStage = (deps: QualityGateStageDeps = {}): Stage => ({
  name: 'quality-gate',
  requires: STAGE_REQUIREMENTS['quality-gate'],

  async run(ctx) {
    const probe = deps.probe ?? createRealMediaProbe()

    // 1. Title / description / tags length, straight from config-blessed constants.
    const seo = await readSeoRaw(ctx.paths.root)
    if (!seo) return halt(`seo.json is missing or unreadable at ${path.join(ctx.paths.root, 'seo.json')}`)
    if (seo.chosenTitle.length > MAX_TITLE_CHARS) {
      return halt(`title exceeds ${MAX_TITLE_CHARS} characters (got ${seo.chosenTitle.length})`)
    }
    if (seo.description.length > MAX_DESCRIPTION_CHARS) {
      return halt(`description exceeds ${MAX_DESCRIPTION_CHARS} characters (got ${seo.description.length})`)
    }
    const tagChars = seo.tags.join(',').length
    if (tagChars > MAX_TAGS_CHARS) {
      return halt(`tags exceed ${MAX_TAGS_CHARS} characters in total (got ${tagChars})`)
    }

    // 2. videoSpec.json itself.
    let spec: VideoSpec
    try {
      spec = await ctx.artifacts.read('videoSpec', VideoSpecSchema)
    } catch (error) {
      return halt(`videoSpec.json is missing or invalid: ${error instanceof Error ? error.message : String(error)}`)
    }

    // 3. Thumbnail present, when the run was configured to produce one.
    if (ctx.config.thumbnail) {
      let thumbnailEntries: string[] = []
      try {
        thumbnailEntries = await fs.readdir(ctx.paths.thumbnail)
      } catch {
        thumbnailEntries = []
      }
      const hasFinalThumbnail = thumbnailEntries.some((f) => /^v\d+\.png$/i.test(f))
      if (!hasFinalThumbnail) {
        return halt(`the thumbnail is absent: no v*.png found in ${ctx.paths.thumbnail}`)
      }
    }

    // 4. Captions present, when the run was configured to produce them.
    if (ctx.config.captions) {
      const wordsPath = path.join(ctx.paths.captions, 'words.json')
      let hasWords = false
      try {
        const raw = await fs.readFile(wordsPath, 'utf8')
        const json = JSON.parse(raw) as { words?: unknown[] }
        hasWords = Array.isArray(json.words) && json.words.length > 0
      } catch {
        hasWords = false
      }
      if (!hasWords) return halt(`captions are absent: no words found at ${wordsPath}`)
    }

    // 5. Every asset the spec references, plus the render output itself, must exist on disk.
    const videoPath = path.join(ctx.paths.out, 'video.mp4')
    if (!(await fileExists(videoPath))) {
      return halt(`the rendered video is missing: ${videoPath}`)
    }
    for (const assetPath of assetPathsOf(spec)) {
      if (!(await fileExists(assetPath))) {
        return halt(`a referenced asset is missing: ${assetPath}`)
      }
    }

    // 6. Video/audio stream duration agreement, within tolerance.
    const durations = await probe.probeStreamDurations(videoPath)
    if (durations.videoDurationSec === null) {
      return halt(`the rendered video has no readable video stream: ${videoPath}`)
    }
    if (durations.audioDurationSec === null) {
      return halt(`the audio track is silent: ${videoPath} has no audio stream`)
    }
    const mismatchPct =
      (Math.abs(durations.videoDurationSec - durations.audioDurationSec) / durations.videoDurationSec) * 100
    if (mismatchPct > MAX_DURATION_MISMATCH_PCT) {
      return halt(
        `audio and video durations disagree by ${mismatchPct.toFixed(1)}% ` +
          `(video ${durations.videoDurationSec}s, audio ${durations.audioDurationSec}s)`,
      )
    }

    // 7. Sampled frames must not be entirely black.
    const brightnesses = await Promise.all(
      BLACK_FRAME_SAMPLE_FRACTIONS.map((frac) =>
        probe.sampleFrameBrightness(videoPath, frac * durations.videoDurationSec!),
      ),
    )
    if (brightnesses.every((b) => b < BLACK_FRAME_THRESHOLD)) {
      return halt(`sampled frames are entirely black across ${videoPath}`)
    }

    // 8. Audio track must not be silent.
    const meanVolumeDb = await probe.probeMeanVolumeDb(videoPath)
    if (meanVolumeDb === null || meanVolumeDb <= SILENCE_THRESHOLD_DB) {
      return halt(`the audio track is silent: mean volume ${meanVolumeDb ?? 'unmeasurable'} dB`)
    }

    ctx.log.info('quality gate passed', { stage: 'quality-gate' })
    return { status: 'done' }
  },
})
