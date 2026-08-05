import { describe, expect, it } from 'vitest'
import { CaptionsFileSchema, ThumbnailJobSchema, VideoSpecSchema } from './render'

const validSpec = () => ({
  runId: 'run-1',
  format: 'shorts' as const,
  width: 1080,
  height: 1920,
  fps: 30,
  durationSec: 10,
  title: 'A title',
  scenes: [
    {
      id: 'scene-1',
      startSec: 0,
      durationSec: 5,
      text: 'Hello',
      visual: { kind: 'image' as const, path: '/tmp/images/scene-1.png' },
      camera: 'zoom-in' as const,
      audioPath: '/tmp/audio/scene-1.wav',
    },
    {
      id: 'scene-2',
      startSec: 5,
      durationSec: 5,
      text: 'World',
      visual: { kind: 'clip' as const, path: '/tmp/clips/scene-2.mp4', fallbackImagePath: '/tmp/images/scene-2.png' },
      camera: 'pan-left' as const,
      audioPath: '/tmp/audio/scene-2.wav',
    },
  ],
  captions: [{ word: 'Hello', startSec: 0, endSec: 0.5 }],
  musicPath: null,
  brandCorner: { enabled: true, position: 'bottom-right' as const },
})

describe('VideoSpecSchema', () => {
  it('accepts a well-formed spec', () => {
    expect(VideoSpecSchema.safeParse(validSpec()).success).toBe(true)
  })

  it('rejects a durationSec that does not match the sum of scene durations', () => {
    const bad = { ...validSpec(), durationSec: 999 }
    const result = VideoSpecSchema.safeParse(bad)
    expect(result.success).toBe(false)
  })

  it('accepts small floating point slack between durationSec and the scene sum', () => {
    const spec = validSpec()
    const withSlack = { ...spec, durationSec: spec.durationSec + 0.2 }
    expect(VideoSpecSchema.safeParse(withSlack).success).toBe(true)
  })

  it('rejects a motion-graphic visual without a variant', () => {
    const spec = validSpec()
    spec.scenes[0] = { ...spec.scenes[0]!, visual: { kind: 'motion-graphic' as any, payload: {} } as any }
    expect(VideoSpecSchema.safeParse(spec).success).toBe(false)
  })

  it('requires at least one scene', () => {
    const spec = { ...validSpec(), scenes: [] }
    expect(VideoSpecSchema.safeParse(spec).success).toBe(false)
  })
})

describe('CaptionsFileSchema', () => {
  it('accepts an empty word list', () => {
    expect(CaptionsFileSchema.safeParse({ words: [] }).success).toBe(true)
  })

  it('rejects a word missing timing', () => {
    expect(CaptionsFileSchema.safeParse({ words: [{ word: 'hi' }] }).success).toBe(false)
  })
})

describe('ThumbnailJobSchema', () => {
  it('accepts a well-formed job', () => {
    expect(
      ThumbnailJobSchema.safeParse({
        sourceImagePath: '/tmp/thumbnail/raw-v1.png',
        outPath: '/tmp/thumbnail/v1.png',
        title: 'A title',
        width: 1280,
        height: 720,
      }).success,
    ).toBe(true)
  })
})
