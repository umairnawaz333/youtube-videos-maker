import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_DESCRIPTION_CHARS,
  MAX_TAGS_CHARS,
  MAX_TITLE_CHARS,
  SeoSchema,
  VideoSpecSchema,
  type Seo,
  type VideoSpec,
} from '@yt/core'
import { createQualityGateStage } from './quality-gate'
import type { MediaProbe, StreamDurations } from '../media/media-probe'
import { makeStageContext, type StageHarness } from '../../../../test/fixtures/stage-context'

let h: StageHarness

const seoFixture = (overrides: Partial<Seo> = {}): Seo => ({
  titles: Array.from({ length: 20 }, (_, i) => ({
    title: i === 0 ? 'The chosen title' : `Alternate title ${i}`,
    scores: { curiosity: 5, searchIntent: 5, simplicity: 5, ctr: 5 },
    total: 20,
  })),
  chosenTitle: 'The chosen title',
  description: 'A description.',
  tags: ['tag1', 'tag2'],
  hashtags: ['#tag1'],
  ...overrides,
})

const healthyProbe = (overrides: Partial<MediaProbe> = {}): MediaProbe => ({
  async probeStreamDurations(): Promise<StreamDurations> {
    return { videoDurationSec: 10, audioDurationSec: 10 }
  },
  async sampleFrameBrightness() {
    return 120
  },
  async probeMeanVolumeDb() {
    return -18
  },
  ...overrides,
})

/** Writes a fully valid run: videoSpec, seo, and every asset/thumbnail/caption file it names. */
const setupHealthyRun = async (h: StageHarness) => {
  await h.ctx.artifacts.write('seo', SeoSchema, seoFixture())

  const imagePath = path.join(h.ctx.paths.images, 'scene-1.png')
  const audioPath = path.join(h.ctx.paths.audio, 'scene-1.wav')
  await fs.writeFile(imagePath, Buffer.from([0]))
  await fs.writeFile(audioPath, Buffer.from([0]))

  const spec: VideoSpec = {
    runId: h.ctx.runId,
    format: h.ctx.config.preset.format,
    width: h.ctx.config.preset.width,
    height: h.ctx.config.preset.height,
    fps: h.ctx.config.preset.fps,
    durationSec: 10,
    title: 'The chosen title',
    scenes: [
      {
        id: 'scene-1',
        startSec: 0,
        durationSec: 10,
        text: 'Hello',
        visual: { kind: 'image', path: imagePath },
        camera: 'zoom-in',
        audioPath,
      },
    ],
    captions: [{ word: 'Hello', startSec: 0, endSec: 0.5 }],
    musicPath: null,
    brandCorner: { enabled: true, position: 'bottom-right' },
  }
  await h.ctx.artifacts.write('videoSpec', VideoSpecSchema, spec)

  await fs.writeFile(path.join(h.ctx.paths.out, 'video.mp4'), Buffer.from([0]))
  await fs.writeFile(path.join(h.ctx.paths.thumbnail, 'v1.png'), Buffer.from([0]))
  await fs.writeFile(
    path.join(h.ctx.paths.captions, 'words.json'),
    JSON.stringify({ words: [{ word: 'Hello', startSec: 0, endSec: 0.5 }] }),
    'utf8',
  )
}

beforeEach(async () => {
  h = await makeStageContext({ videoType: 'long' })
})
afterEach(async () => {
  await h.cleanup()
})

describe('createQualityGateStage', () => {
  it('passes a fully healthy run', async () => {
    await setupHealthyRun(h)
    const outcome = await createQualityGateStage({ probe: healthyProbe() }).run(h.ctx)
    expect(outcome).toEqual({ status: 'done' })
  })

  it('halts when the video and audio stream durations disagree by more than 2%', async () => {
    await setupHealthyRun(h)
    const probe = healthyProbe({
      async probeStreamDurations() {
        return { videoDurationSec: 10, audioDurationSec: 8 } // 20% off
      },
    })
    const outcome = await createQualityGateStage({ probe }).run(h.ctx)
    expect(outcome).toMatchObject({ status: 'halted' })
    expect((outcome as { reason: string }).reason).toMatch(/duration/i)
  })

  it('tolerates a sub-2% duration difference', async () => {
    await setupHealthyRun(h)
    const probe = healthyProbe({
      async probeStreamDurations() {
        return { videoDurationSec: 10, audioDurationSec: 9.85 } // 1.5% off
      },
    })
    const outcome = await createQualityGateStage({ probe }).run(h.ctx)
    expect(outcome).toEqual({ status: 'done' })
  })

  it('halts when a referenced asset is missing', async () => {
    await setupHealthyRun(h)
    await fs.rm(path.join(h.ctx.paths.images, 'scene-1.png'))
    const outcome = await createQualityGateStage({ probe: healthyProbe() }).run(h.ctx)
    expect(outcome).toMatchObject({ status: 'halted' })
    expect((outcome as { reason: string }).reason).toMatch(/scene-1\.png/)
  })

  it('halts when sampled frames are entirely black', async () => {
    await setupHealthyRun(h)
    const probe = healthyProbe({ async sampleFrameBrightness() { return 0 } })
    const outcome = await createQualityGateStage({ probe }).run(h.ctx)
    expect(outcome).toMatchObject({ status: 'halted' })
    expect((outcome as { reason: string }).reason).toMatch(/black/i)
  })

  it('does not halt when only some sampled frames are black', async () => {
    await setupHealthyRun(h)
    let call = 0
    const probe = healthyProbe({
      async sampleFrameBrightness() {
        call += 1
        return call === 1 ? 0 : 120
      },
    })
    const outcome = await createQualityGateStage({ probe }).run(h.ctx)
    expect(outcome).toEqual({ status: 'done' })
  })

  it('halts when the audio track is silent', async () => {
    await setupHealthyRun(h)
    const probe = healthyProbe({ async probeMeanVolumeDb() { return -95 } })
    const outcome = await createQualityGateStage({ probe }).run(h.ctx)
    expect(outcome).toMatchObject({ status: 'halted' })
    expect((outcome as { reason: string }).reason).toMatch(/silent/i)
  })

  it('halts when the thumbnail is absent', async () => {
    await setupHealthyRun(h)
    await fs.rm(path.join(h.ctx.paths.thumbnail, 'v1.png'))
    const outcome = await createQualityGateStage({ probe: healthyProbe() }).run(h.ctx)
    expect(outcome).toMatchObject({ status: 'halted' })
    expect((outcome as { reason: string }).reason).toMatch(/thumbnail/i)
  })

  it('halts when captions are absent', async () => {
    await setupHealthyRun(h)
    await fs.rm(path.join(h.ctx.paths.captions, 'words.json'))
    const outcome = await createQualityGateStage({ probe: healthyProbe() }).run(h.ctx)
    expect(outcome).toMatchObject({ status: 'halted' })
    expect((outcome as { reason: string }).reason).toMatch(/caption/i)
  })

  it('halts when the title exceeds the character limit', async () => {
    await setupHealthyRun(h)
    // Overwrite seo.json directly: SeoSchema itself already forbids an over-limit title, so
    // this simulates the artifact having been corrupted or hand-edited after the SEO stage.
    await fs.writeFile(
      path.join(h.ctx.paths.root, 'seo.json'),
      JSON.stringify({ ...seoFixture(), chosenTitle: 'x'.repeat(MAX_TITLE_CHARS + 1) }),
      'utf8',
    )
    const outcome = await createQualityGateStage({ probe: healthyProbe() }).run(h.ctx)
    expect(outcome).toMatchObject({ status: 'halted' })
    expect((outcome as { reason: string }).reason).toMatch(/title/i)
  })

  it('halts when the description exceeds the character limit', async () => {
    await setupHealthyRun(h)
    await fs.writeFile(
      path.join(h.ctx.paths.root, 'seo.json'),
      JSON.stringify({ ...seoFixture(), description: 'x'.repeat(MAX_DESCRIPTION_CHARS + 1) }),
      'utf8',
    )
    const outcome = await createQualityGateStage({ probe: healthyProbe() }).run(h.ctx)
    expect(outcome).toMatchObject({ status: 'halted' })
    expect((outcome as { reason: string }).reason).toMatch(/description/i)
  })

  it('halts when the tags exceed the total character limit', async () => {
    await setupHealthyRun(h)
    await fs.writeFile(
      path.join(h.ctx.paths.root, 'seo.json'),
      JSON.stringify({ ...seoFixture(), tags: ['x'.repeat(MAX_TAGS_CHARS + 1)] }),
      'utf8',
    )
    const outcome = await createQualityGateStage({ probe: healthyProbe() }).run(h.ctx)
    expect(outcome).toMatchObject({ status: 'halted' })
    expect((outcome as { reason: string }).reason).toMatch(/tags/i)
  })

  it('halts when out/video.mp4 itself is missing', async () => {
    await setupHealthyRun(h)
    await fs.rm(path.join(h.ctx.paths.out, 'video.mp4'))
    const outcome = await createQualityGateStage({ probe: healthyProbe() }).run(h.ctx)
    expect(outcome).toMatchObject({ status: 'halted' })
    expect((outcome as { reason: string }).reason).toMatch(/video\.mp4/)
  })

  it('names the specific reason for a deliberately broken run (acceptance criterion)', async () => {
    // Spec's own acceptance check: "the quality gate demonstrably blocks a deliberately
    // broken run and names the reason." Break exactly one thing and require a legible,
    // specific message rather than a generic failure.
    await setupHealthyRun(h)
    const probe = healthyProbe({ async probeMeanVolumeDb() { return -90 } })

    const outcome = await createQualityGateStage({ probe }).run(h.ctx)

    expect(outcome.status).toBe('halted')
    const reason = (outcome as { reason: string }).reason
    expect(reason.length).toBeGreaterThan(10)
    expect(reason).toMatch(/silent/i)
  })
})
