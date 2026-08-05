import type { VideoFormat } from './domain'

export interface FormatPreset {
  format: VideoFormat
  width: number
  height: number
  fps: number
  minDurationSec: number
  maxDurationSec: number
  minScenes: number
  maxScenes: number
  /** Generated images per video. Roughly one per 8-10 seconds of narration. */
  imageBudget: number
  /** Human-supplied Veo clips per video. Scarce; spent on hero sections only. */
  clipBudget: number
}

export const FORMAT_PRESETS: Record<VideoFormat, FormatPreset> = {
  shorts: {
    format: 'shorts',
    width: 1080,
    height: 1920,
    fps: 30,
    // 120s is the floor imposed by the eight-section arc: 8 sections x 1 beat x 15s minimum.
    // Anything shorter cannot carry the story structure the schema enforces.
    minDurationSec: 120,
    maxDurationSec: 180,
    minScenes: 12,
    maxScenes: 30,
    imageBudget: 22,
    clipBudget: 2,
  },
  long: {
    format: 'long',
    width: 1920,
    height: 1080,
    fps: 30,
    minDurationSec: 480,
    maxDurationSec: 600,
    minScenes: 60,
    maxScenes: 90,
    imageBudget: 70,
    clipBudget: 6,
  },
}
