import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface StreamDurations {
  videoDurationSec: number | null
  audioDurationSec: number | null
}

/**
 * The boundary between QualityGate's checks and the real `ffmpeg`/`ffprobe` binaries. Real
 * media probing never runs in the unit suite (constraint: no ffmpeg spawning against real
 * media in tests) — every QualityGate test injects a fake implementation instead.
 */
export interface MediaProbe {
  /** Per-stream durations of a muxed file, so a video/audio mismatch is directly visible. */
  probeStreamDurations(path: string): Promise<StreamDurations>
  /** Mean pixel brightness (0-255) of the frame at `atSec`. Near 0 means an all-black frame. */
  sampleFrameBrightness(path: string, atSec: number): Promise<number>
  /** Mean volume in dBFS across the whole file, or null when it has no audio stream at all. */
  probeMeanVolumeDb(path: string): Promise<number | null>
}

const parseStreamDurations = (stdout: string): StreamDurations => {
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string; duration?: string }>
  }
  const video = parsed.streams?.find((s) => s.codec_type === 'video')
  const audio = parsed.streams?.find((s) => s.codec_type === 'audio')
  return {
    videoDurationSec: video?.duration ? Number(video.duration) : null,
    audioDurationSec: audio?.duration ? Number(audio.duration) : null,
  }
}

const parseMeanVolumeDb = (stderr: string): number | null => {
  const match = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/)
  return match ? Number(match[1]) : null
}

/** Real adapter. Never invoked by the unit suite — only reachable via explicit injection. */
export const createRealMediaProbe = (): MediaProbe => ({
  async probeStreamDurations(path) {
    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,duration',
        '-of',
        'json',
        path,
      ])
      return parseStreamDurations(stdout)
    } catch {
      return { videoDurationSec: null, audioDurationSec: null }
    }
  },

  async sampleFrameBrightness(path, atSec) {
    try {
      const { stdout } = await execFileAsync(
        'ffmpeg',
        ['-ss', String(atSec), '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', '16x16', '-'],
        { encoding: 'buffer', maxBuffer: 1024 * 1024 },
      )
      const buffer = stdout as unknown as Buffer
      if (buffer.length === 0) return 0
      let sum = 0
      for (const byte of buffer) sum += byte
      return sum / buffer.length
    } catch {
      return 0
    }
  },

  async probeMeanVolumeDb(path) {
    // volumedetect writes its report to stderr; -f null discards the transcoded output.
    // ffmpeg normally exits 0 here, but treat a non-zero exit the same way: its stderr still
    // carries the mean_volume line up to the point of failure, and a file with no audio
    // stream at all fails outright — which is exactly the "no measurable audio" case this
    // method must report as null rather than let bubble up as an unhandled rejection.
    try {
      const { stderr } = await execFileAsync('ffmpeg', ['-i', path, '-af', 'volumedetect', '-f', 'null', '-'])
      return parseMeanVolumeDb(stderr)
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? ''
      return parseMeanVolumeDb(stderr)
    }
  },
})
