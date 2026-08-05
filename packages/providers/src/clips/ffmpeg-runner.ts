import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface ClipProbe {
  /** False when ffprobe cannot find a decodable video stream at all. */
  decodable: boolean
  durationSec: number
  width: number
  height: number
}

/**
 * The boundary between the manual clip provider's decision logic and the real `ffmpeg`/
 * `ffprobe` binaries. Kept as an injectable seam — never called directly — so the provider's
 * accept/reject/fit rules can be unit-tested against canned probes and recorded commands
 * instead of spawning real processes against real media (forbidden in the unit suite; see
 * the render-block report).
 */
export interface FfmpegRunner {
  probe(path: string): Promise<ClipProbe>
  run(args: string[]): Promise<void>
}

/** Real adapter. Never invoked by the unit suite — only reachable via explicit injection. */
export const createRealFfmpegRunner = (): FfmpegRunner => ({
  async probe(path) {
    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height:format=duration',
        '-of',
        'json',
        path,
      ])
      const parsed = JSON.parse(stdout) as {
        streams?: Array<{ width?: number; height?: number }>
        format?: { duration?: string }
      }
      const stream = parsed.streams?.[0]
      if (!stream) return { decodable: false, durationSec: 0, width: 0, height: 0 }
      return {
        decodable: true,
        durationSec: Number(parsed.format?.duration ?? 0),
        width: stream.width ?? 0,
        height: stream.height ?? 0,
      }
    } catch {
      return { decodable: false, durationSec: 0, width: 0, height: 0 }
    }
  },
  async run(args) {
    await execFileAsync('ffmpeg', ['-y', ...args])
  },
})
