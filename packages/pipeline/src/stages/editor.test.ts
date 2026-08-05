import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ScenePlanSchema, SeoSchema, VideoSpecSchema, type Scene, type Seo, type ThumbnailJob, type VideoSpec } from '@yt/core'
import { createEditorStage } from './editor'
import type { VideoRenderer } from '../render/renderer'
import { sceneAudioPath, sceneImagePath } from '../render/asset-paths'
import { makeStageContext, type StageHarness } from '../../../../test/fixtures/stage-context'

let h: StageHarness
let repoRoot: string

const seoFixture = (chosenTitle: string): Seo => ({
  titles: Array.from({ length: 20 }, (_, i) => ({
    title: i === 0 ? chosenTitle : `Alternate title ${i}`,
    scores: { curiosity: 5, searchIntent: 5, simplicity: 5, ctr: 5 },
    total: 20,
  })),
  chosenTitle,
  description: 'A description.',
  tags: ['tag1', 'tag2'],
  hashtags: ['#tag1'],
})

const imageScene = (id: string, durationSec: number): Scene => ({
  id,
  beatId: `${id}-beat`,
  text: `Narration for ${id}.`,
  visual: { kind: 'sd-image', prompt: `An image for ${id}` },
  camera: 'zoom-in',
  durationSec,
})

const fakeRenderer = (): VideoRenderer & { videos: VideoSpec[]; outPaths: string[]; thumbJobs: ThumbnailJob[][] } => {
  const videos: VideoSpec[] = []
  const outPaths: string[] = []
  const thumbJobs: ThumbnailJob[][] = []
  return {
    videos,
    outPaths,
    thumbJobs,
    async renderVideo(spec, outPath) {
      videos.push(spec)
      outPaths.push(outPath)
      return { durationSec: spec.durationSec }
    },
    async renderThumbnails(jobs) {
      thumbJobs.push(jobs)
    },
  }
}

beforeEach(async () => {
  h = await makeStageContext({ videoType: 'long' })
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-editor-repo-'))
  await h.ctx.artifacts.write('seo', SeoSchema, seoFixture('The chosen title'))
})

afterEach(async () => {
  await h.cleanup()
  await fs.rm(repoRoot, { recursive: true, force: true })
})

describe('createEditorStage', () => {
  it('halts when a scene has no measured duration yet', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: [{ ...imageScene('scene-1', 5), durationSec: undefined }],
    })
    const renderer = fakeRenderer()

    const outcome = await createEditorStage({ renderer, repoRoot }).run(h.ctx)
    expect(outcome).toMatchObject({ status: 'halted' })
    expect((outcome as { reason: string }).reason).toMatch(/duration/i)
  })

  it('assembles a videoSpec with cumulative scene offsets and the right total duration', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: [imageScene('scene-1', 5), imageScene('scene-2', 3), imageScene('scene-3', 4)],
    })
    const renderer = fakeRenderer()

    const outcome = await createEditorStage({ renderer, repoRoot }).run(h.ctx)
    expect(outcome).toEqual({ status: 'done' })

    const spec = await h.ctx.artifacts.read('videoSpec', VideoSpecSchema)
    expect(spec.durationSec).toBe(12)
    expect(spec.scenes.map((s) => [s.id, s.startSec, s.durationSec])).toEqual([
      ['scene-1', 0, 5],
      ['scene-2', 5, 3],
      ['scene-3', 8, 4],
    ])
    expect(spec.title).toBe('The chosen title')
    expect(spec.format).toBe('long')
    expect(spec.width).toBe(h.ctx.config.preset.width)
    expect(spec.height).toBe(h.ctx.config.preset.height)
    expect(spec.fps).toBe(h.ctx.config.preset.fps)
  })

  it('resolves an sd-image scene to its conventional image path', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, { scenes: [imageScene('scene-1', 5)] })
    const renderer = fakeRenderer()

    await createEditorStage({ renderer, repoRoot }).run(h.ctx)
    const spec = await h.ctx.artifacts.read('videoSpec', VideoSpecSchema)
    expect(spec.scenes[0]!.visual).toEqual({ kind: 'image', path: sceneImagePath(h.ctx.paths, 'scene-1') })
    expect(spec.scenes[0]!.audioPath).toBe(sceneAudioPath(h.ctx.paths, 'scene-1'))
  })

  it('resolves a reuse scene to the referenced scene\'s image path', async () => {
    const scenes: Scene[] = [
      imageScene('scene-1', 5),
      { ...imageScene('scene-2', 4), visual: { kind: 'reuse', sceneId: 'scene-1' } },
    ]
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, { scenes })
    const renderer = fakeRenderer()

    await createEditorStage({ renderer, repoRoot }).run(h.ctx)
    const spec = await h.ctx.artifacts.read('videoSpec', VideoSpecSchema)
    expect(spec.scenes[1]!.visual).toEqual({ kind: 'image', path: sceneImagePath(h.ctx.paths, 'scene-1') })
  })

  it('passes a motion-graphic scene through unchanged', async () => {
    const scenes: Scene[] = [
      {
        ...imageScene('scene-1', 5),
        visual: { kind: 'motion-graphic', variant: 'stat', payload: { value: 42 } },
      },
    ]
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, { scenes })
    const renderer = fakeRenderer()

    await createEditorStage({ renderer, repoRoot }).run(h.ctx)
    const spec = await h.ctx.artifacts.read('videoSpec', VideoSpecSchema)
    expect(spec.scenes[0]!.visual).toEqual({ kind: 'motion-graphic', variant: 'stat', payload: { value: 42 } })
  })

  it('resolves a fulfilled veo-clip scene to its normalised clip, with the image as fallback', async () => {
    const scenes: Scene[] = [
      imageScene('scene-ref', 5),
      {
        ...imageScene('scene-hook', 6),
        visual: {
          kind: 'veo-clip',
          prompt: 'A clip',
          referenceSceneId: 'scene-ref',
          fallbackPrompt: 'A fallback image',
        },
      },
    ]
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, { scenes })
    await h.ctx.clipRequests.create(h.ctx.runId, [
      { sceneId: 'scene-hook', prompt: 'A clip', referenceImagePath: null, targetSeconds: 6 },
    ])
    await h.ctx.clipRequests.markFulfilled(h.ctx.runId, 'scene-hook', '/tmp/normalised/scene-hook.mp4')
    const renderer = fakeRenderer()

    await createEditorStage({ renderer, repoRoot }).run(h.ctx)
    const spec = await h.ctx.artifacts.read('videoSpec', VideoSpecSchema)
    expect(spec.scenes[1]!.visual).toEqual({
      kind: 'clip',
      path: '/tmp/normalised/scene-hook.mp4',
      fallbackImagePath: sceneImagePath(h.ctx.paths, 'scene-hook'),
    })
  })

  it('falls back a skipped veo-clip scene to its image', async () => {
    const scenes: Scene[] = [
      imageScene('scene-ref', 5),
      {
        ...imageScene('scene-hook', 6),
        visual: {
          kind: 'veo-clip',
          prompt: 'A clip',
          referenceSceneId: 'scene-ref',
          fallbackPrompt: 'A fallback image',
        },
      },
    ]
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, { scenes })
    await h.ctx.clipRequests.create(h.ctx.runId, [
      { sceneId: 'scene-hook', prompt: 'A clip', referenceImagePath: null, targetSeconds: 6 },
    ])
    await h.ctx.clipRequests.markSkipped(h.ctx.runId, 'scene-hook')
    const renderer = fakeRenderer()

    await createEditorStage({ renderer, repoRoot }).run(h.ctx)
    const spec = await h.ctx.artifacts.read('videoSpec', VideoSpecSchema)
    expect(spec.scenes[1]!.visual).toEqual({ kind: 'image', path: sceneImagePath(h.ctx.paths, 'scene-hook') })
  })

  it('reads captions/words.json when present', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, { scenes: [imageScene('scene-1', 5)] })
    await fs.writeFile(
      path.join(h.ctx.paths.captions, 'words.json'),
      JSON.stringify({ words: [{ word: 'Hi', startSec: 0, endSec: 0.4 }] }),
      'utf8',
    )
    const renderer = fakeRenderer()

    await createEditorStage({ renderer, repoRoot }).run(h.ctx)
    const spec = await h.ctx.artifacts.read('videoSpec', VideoSpecSchema)
    expect(spec.captions).toEqual([{ word: 'Hi', startSec: 0, endSec: 0.4 }])
  })

  it('defaults to an empty caption track when words.json is absent', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, { scenes: [imageScene('scene-1', 5)] })
    const renderer = fakeRenderer()

    await createEditorStage({ renderer, repoRoot }).run(h.ctx)
    const spec = await h.ctx.artifacts.read('videoSpec', VideoSpecSchema)
    expect(spec.captions).toEqual([])
  })

  it('resolves music from the manifest when the niche mood matches a track', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, { scenes: [imageScene('scene-1', 5)] })
    await fs.mkdir(path.join(repoRoot, 'assets/music'), { recursive: true })
    await fs.writeFile(
      path.join(repoRoot, 'assets/music/manifest.json'),
      JSON.stringify({ tracks: [{ file: 'drone.mp3', mood: 'ambient-drone', license: 'CC0' }] }),
      'utf8',
    )
    const renderer = fakeRenderer()

    await createEditorStage({ renderer, repoRoot }).run(h.ctx)
    const spec = await h.ctx.artifacts.read('videoSpec', VideoSpecSchema)
    expect(spec.musicPath).toBe(path.join(repoRoot, 'assets/music/drone.mp3'))
  })

  it('leaves music null when there is no manifest', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, { scenes: [imageScene('scene-1', 5)] })
    const renderer = fakeRenderer()

    await createEditorStage({ renderer, repoRoot }).run(h.ctx)
    const spec = await h.ctx.artifacts.read('videoSpec', VideoSpecSchema)
    expect(spec.musicPath).toBeNull()
  })

  it('invokes the renderer with the assembled spec and writes out/video.mp4', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, { scenes: [imageScene('scene-1', 5)] })
    const renderer = fakeRenderer()

    const outcome = await createEditorStage({ renderer, repoRoot }).run(h.ctx)
    expect(outcome).toEqual({ status: 'done' })
    expect(renderer.videos).toHaveLength(1)
    expect(renderer.outPaths[0]).toBe(path.join(h.ctx.paths.out, 'video.mp4'))
  })

  it('composites a thumbnail job for every raw hero image found', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, { scenes: [imageScene('scene-1', 5)] })
    for (const n of [1, 2]) {
      await fs.writeFile(path.join(h.ctx.paths.thumbnail, `raw-v${n}.png`), Buffer.from([0]))
    }
    const renderer = fakeRenderer()

    await createEditorStage({ renderer, repoRoot }).run(h.ctx)
    expect(renderer.thumbJobs).toHaveLength(1)
    expect(renderer.thumbJobs[0]).toEqual([
      {
        sourceImagePath: path.join(h.ctx.paths.thumbnail, 'raw-v1.png'),
        outPath: path.join(h.ctx.paths.thumbnail, 'v1.png'),
        title: 'The chosen title',
        width: 1280,
        height: 720,
      },
      {
        sourceImagePath: path.join(h.ctx.paths.thumbnail, 'raw-v2.png'),
        outPath: path.join(h.ctx.paths.thumbnail, 'v2.png'),
        title: 'The chosen title',
        width: 1280,
        height: 720,
      },
    ])
  })

  it('skips thumbnail compositing gracefully when no raw hero images exist', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, { scenes: [imageScene('scene-1', 5)] })
    const renderer = fakeRenderer()

    const outcome = await createEditorStage({ renderer, repoRoot }).run(h.ctx)
    expect(outcome).toEqual({ status: 'done' })
    expect(renderer.thumbJobs).toHaveLength(0)
  })
})
