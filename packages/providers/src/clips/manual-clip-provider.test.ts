import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClipRequestSpec } from '@yt/core'
import { createManualClipProvider } from './manual-clip-provider'
import type { ClipProbe, FfmpegRunner } from './ffmpeg-runner'

let root: string
let inboxDir: string
let normalisedDir: string
let requestsFile: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-clips-'))
  inboxDir = path.join(root, 'inbox')
  normalisedDir = path.join(root, 'normalised')
  requestsFile = path.join(root, 'REQUESTS.md')
  await fs.mkdir(inboxDir, { recursive: true })
  await fs.mkdir(normalisedDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const spec = (overrides: Partial<ClipRequestSpec> = {}): ClipRequestSpec => ({
  sceneId: 'scene-hook-0',
  prompt: 'A dust storm rolling over red dunes',
  referenceImagePath: '/tmp/images/scene-hook-0.png',
  targetSeconds: 6,
  aspectRatio: '16:9',
  ...overrides,
})

const fakeFfmpeg = (probeResult: ClipProbe): FfmpegRunner & { runCalls: string[][] } => {
  const runCalls: string[][] = []
  return {
    runCalls,
    async probe() {
      return probeResult
    },
    async run(args) {
      runCalls.push(args)
    },
  }
}

describe('createManualClipProvider.request', () => {
  it('writes a human-readable shot list and pauses', async () => {
    const provider = createManualClipProvider(
      { requestsFile, inboxDir, normalisedDir },
      { maxSeconds: 8, stripAudio: true, width: 1920, height: 1080, fps: 30 },
      fakeFfmpeg({ decodable: true, durationSec: 6, width: 1920, height: 1080 }),
    )

    const result = await provider.request([spec()])

    expect(result).toEqual({ status: 'paused' })
    const written = await fs.readFile(requestsFile, 'utf8')
    expect(written).toContain('scene-hook-0')
    expect(written).toContain('A dust storm rolling over red dunes')
    expect(written).toContain('/tmp/images/scene-hook-0.png')
    expect(written).toContain('16:9')
    expect(written).toContain('6')
  })
})

describe('createManualClipProvider.collect', () => {
  it('reports a scene as unresolved when nothing was dropped into the inbox', async () => {
    const provider = createManualClipProvider(
      { requestsFile, inboxDir, normalisedDir },
      { maxSeconds: 8, stripAudio: true, width: 1920, height: 1080, fps: 30 },
      fakeFfmpeg({ decodable: true, durationSec: 6, width: 1920, height: 1080 }),
    )

    const results = await provider.collect([spec()])
    expect(results).toEqual([{ sceneId: 'scene-hook-0', path: null }])
  })

  it('rejects an undecodable file without normalising it', async () => {
    await fs.writeFile(path.join(inboxDir, 'scene-hook-0.mp4'), 'not a real video')
    const ffmpeg = fakeFfmpeg({ decodable: false, durationSec: 0, width: 0, height: 0 })

    const provider = createManualClipProvider(
      { requestsFile, inboxDir, normalisedDir },
      { maxSeconds: 8, stripAudio: true, width: 1920, height: 1080, fps: 30 },
      ffmpeg,
    )

    const results = await provider.collect([spec()])
    expect(results).toEqual([{ sceneId: 'scene-hook-0', path: null }])
    expect(ffmpeg.runCalls).toHaveLength(0)
  })

  it('rejects a clip longer than the configured max plus tolerance', async () => {
    await fs.writeFile(path.join(inboxDir, 'scene-hook-0.mp4'), 'x')
    const ffmpeg = fakeFfmpeg({ decodable: true, durationSec: 20, width: 1920, height: 1080 })

    const provider = createManualClipProvider(
      { requestsFile, inboxDir, normalisedDir },
      { maxSeconds: 8, stripAudio: true, width: 1920, height: 1080, fps: 30 },
      ffmpeg,
    )

    const results = await provider.collect([spec({ targetSeconds: 6 })])
    expect(results).toEqual([{ sceneId: 'scene-hook-0', path: null }])
    expect(ffmpeg.runCalls).toHaveLength(0)
  })

  it('rejects a clip below 720p', async () => {
    await fs.writeFile(path.join(inboxDir, 'scene-hook-0.mp4'), 'x')
    const ffmpeg = fakeFfmpeg({ decodable: true, durationSec: 6, width: 640, height: 480 })

    const provider = createManualClipProvider(
      { requestsFile, inboxDir, normalisedDir },
      { maxSeconds: 8, stripAudio: true, width: 1920, height: 1080, fps: 30 },
      ffmpeg,
    )

    const results = await provider.collect([spec()])
    expect(results).toEqual([{ sceneId: 'scene-hook-0', path: null }])
    expect(ffmpeg.runCalls).toHaveLength(0)
  })

  it('rejects a clip whose aspect ratio does not match the requested one', async () => {
    await fs.writeFile(path.join(inboxDir, 'scene-hook-0.mp4'), 'x')
    // 16:9 footage submitted for a 9:16 shot.
    const ffmpeg = fakeFfmpeg({ decodable: true, durationSec: 6, width: 1920, height: 1080 })

    const provider = createManualClipProvider(
      { requestsFile, inboxDir, normalisedDir },
      { maxSeconds: 8, stripAudio: true, width: 1080, height: 1920, fps: 30 },
      ffmpeg,
    )

    const results = await provider.collect([spec({ aspectRatio: '9:16' })])
    expect(results).toEqual([{ sceneId: 'scene-hook-0', path: null }])
    expect(ffmpeg.runCalls).toHaveLength(0)
  })

  it('trims a clip longer than the scene duration', async () => {
    await fs.writeFile(path.join(inboxDir, 'scene-hook-0.mp4'), 'x')
    const ffmpeg = fakeFfmpeg({ decodable: true, durationSec: 8, width: 1920, height: 1080 })

    const provider = createManualClipProvider(
      { requestsFile, inboxDir, normalisedDir },
      { maxSeconds: 8, stripAudio: true, width: 1920, height: 1080, fps: 30 },
      ffmpeg,
    )

    const results = await provider.collect([spec({ targetSeconds: 5 })])
    expect(results).toEqual([{ sceneId: 'scene-hook-0', path: path.join(normalisedDir, 'scene-hook-0.mp4') }])
    expect(ffmpeg.runCalls).toHaveLength(1)
    const args = ffmpeg.runCalls[0]!
    expect(args).toContain('-t')
    expect(args).toContain('5')
    expect(args).toContain('-an') // stripAudio: true
  })

  it('slows a clip that is shorter by up to 25% to fit the scene duration', async () => {
    await fs.writeFile(path.join(inboxDir, 'scene-hook-0.mp4'), 'x')
    // 4.5s clip against a 5s target scene: short by 10%, within the 25% slow-fit band.
    const ffmpeg = fakeFfmpeg({ decodable: true, durationSec: 4.5, width: 1920, height: 1080 })

    const provider = createManualClipProvider(
      { requestsFile, inboxDir, normalisedDir },
      { maxSeconds: 8, stripAudio: true, width: 1920, height: 1080, fps: 30 },
      ffmpeg,
    )

    const results = await provider.collect([spec({ targetSeconds: 5 })])
    expect(results[0]!.path).toBe(path.join(normalisedDir, 'scene-hook-0.mp4'))
    const args = ffmpeg.runCalls[0]!
    expect(args.some((a) => a.includes('setpts'))).toBe(true)
  })

  it('holds the final frame when a clip is shorter by more than 25%', async () => {
    await fs.writeFile(path.join(inboxDir, 'scene-hook-0.mp4'), 'x')
    // 3s clip against an 8s target: short by 62.5%, past the 25% slow-fit band.
    const ffmpeg = fakeFfmpeg({ decodable: true, durationSec: 3, width: 1920, height: 1080 })

    const provider = createManualClipProvider(
      { requestsFile, inboxDir, normalisedDir },
      { maxSeconds: 8, stripAudio: true, width: 1920, height: 1080, fps: 30 },
      ffmpeg,
    )

    const results = await provider.collect([spec({ targetSeconds: 8 })])
    expect(results[0]!.path).toBe(path.join(normalisedDir, 'scene-hook-0.mp4'))
    const args = ffmpeg.runCalls[0]!
    expect(args.some((a) => a.includes('tpad'))).toBe(true)
    expect(args.some((a) => a.includes('stop_duration=5'))).toBe(true)
  })

  it('keeps audio when stripAudio is false', async () => {
    await fs.writeFile(path.join(inboxDir, 'scene-hook-0.mp4'), 'x')
    const ffmpeg = fakeFfmpeg({ decodable: true, durationSec: 6, width: 1920, height: 1080 })

    const provider = createManualClipProvider(
      { requestsFile, inboxDir, normalisedDir },
      { maxSeconds: 8, stripAudio: false, width: 1920, height: 1080, fps: 30 },
      ffmpeg,
    )

    await provider.collect([spec({ targetSeconds: 6 })])
    const args = ffmpeg.runCalls[0]!
    expect(args).not.toContain('-an')
  })

  it('calls the logger with a specific reason when rejecting a clip', async () => {
    await fs.writeFile(path.join(inboxDir, 'scene-hook-0.mp4'), 'x')
    const ffmpeg = fakeFfmpeg({ decodable: false, durationSec: 0, width: 0, height: 0 })
    const logger = vi.fn()

    const provider = createManualClipProvider(
      { requestsFile, inboxDir, normalisedDir },
      { maxSeconds: 8, stripAudio: true, width: 1920, height: 1080, fps: 30 },
      ffmpeg,
      logger,
    )

    await provider.collect([spec()])
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('scene-hook-0'), expect.stringContaining('decod'))
  })
})
