import fs from 'node:fs/promises'
import path from 'node:path'
import {
  CaptionsFileSchema,
  ScenePlanSchema,
  SeoSchema,
  STAGE_REQUIREMENTS,
  VideoSpecSchema,
  type RunPaths,
  type RenderScene,
  type RenderSceneVisual,
  type Scene,
  type Stage,
  type ThumbnailJob,
  type VideoSpec,
} from '@yt/core'
import { sceneAudioPath, sceneImagePath } from '../render/asset-paths'
import { resolveMusicPath } from '../render/music'
import { createChildProcessRenderer, type VideoRenderer } from '../render/renderer'
import { discoverRawThumbnails, finalThumbnailPath, THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH } from '../render/thumbnails'

export interface EditorStageDeps {
  /** Defaults to the real out-of-process Remotion renderer. Tests inject a fake. */
  renderer?: VideoRenderer
  /** Repo root, used to locate `assets/music/manifest.json`. Defaults to `process.cwd()`. */
  repoRoot?: string
}

const resolveVisual = (
  scene: Scene,
  paths: RunPaths,
  clipsBySceneId: Map<string, { fulfilledPath: string | null; skipped: boolean }>,
): RenderSceneVisual => {
  const visual = scene.visual

  if (visual.kind === 'sd-image') {
    return { kind: 'image', path: sceneImagePath(paths, scene.id) }
  }
  if (visual.kind === 'reuse') {
    return { kind: 'image', path: sceneImagePath(paths, visual.sceneId) }
  }
  if (visual.kind === 'motion-graphic') {
    return { kind: 'motion-graphic', variant: visual.variant, payload: visual.payload }
  }
  // veo-clip: use the normalised clip if ClipGate fulfilled it, otherwise the fallback image
  // that the illustrator generated from `fallbackPrompt` under the same `<sceneId>.png`
  // convention as every sd-image scene — a missing clip degrades, it never blocks.
  const clip = clipsBySceneId.get(scene.id)
  if (clip?.fulfilledPath) {
    return { kind: 'clip', path: clip.fulfilledPath, fallbackImagePath: sceneImagePath(paths, scene.id) }
  }
  return { kind: 'image', path: sceneImagePath(paths, scene.id) }
}

/**
 * Editor (spec section 12). Assembles `videoSpec.json` — the single file the renderer is a
 * pure function of — from `scenes.json`, `seo.json`, the caption/audio files already on
 * disk, and config, then hands it to the renderer seam. That assembly step is the only part
 * of this stage that is not re-runnable without a prior pipeline: it is what turns "scenes
 * plus loose files" into the one self-contained spec the actual render never needs an AI
 * model to reproduce. Also composites the Thumbnailer's raw hero images into their final,
 * text-overlaid stills (spec: "Remotion composites the text overlay as a still").
 */
export const createEditorStage = (deps: EditorStageDeps = {}): Stage => ({
  name: 'editor',
  requires: STAGE_REQUIREMENTS['editor'],

  async run(ctx) {
    const plan = await ctx.artifacts.read('scenes', ScenePlanSchema)
    for (const scene of plan.scenes) {
      if (scene.durationSec === undefined) {
        return {
          status: 'halted',
          reason: `scene '${scene.id}' has no measured duration yet; Editor must run after the narrator`,
        }
      }
    }

    const seo = await ctx.artifacts.read('seo', SeoSchema)
    const storedClips = await ctx.clipRequests.listForRun(ctx.runId)
    const clipsBySceneId = new Map(storedClips.map((c) => [c.sceneId, c]))

    let cursor = 0
    const scenes: RenderScene[] = plan.scenes.map((scene) => {
      const durationSec = scene.durationSec as number
      const renderScene: RenderScene = {
        id: scene.id,
        startSec: cursor,
        durationSec,
        text: scene.text,
        visual: resolveVisual(scene, ctx.paths, clipsBySceneId),
        camera: scene.camera,
        audioPath: sceneAudioPath(ctx.paths, scene.id),
      }
      cursor += durationSec
      return renderScene
    })

    let captions: VideoSpec['captions'] = []
    try {
      const raw = await fs.readFile(path.join(ctx.paths.captions, 'words.json'), 'utf8')
      captions = CaptionsFileSchema.parse(JSON.parse(raw)).words
    } catch {
      ctx.log.warn('captions/words.json not found; rendering without captions', { stage: 'editor' })
    }

    const repoRoot = deps.repoRoot ?? process.cwd()
    const musicPath = await resolveMusicPath(repoRoot, ctx.config.nicheConfig.music)

    const spec: VideoSpec = {
      runId: ctx.runId,
      format: ctx.config.preset.format,
      width: ctx.config.preset.width,
      height: ctx.config.preset.height,
      fps: ctx.config.preset.fps,
      durationSec: cursor,
      title: seo.chosenTitle,
      scenes,
      captions,
      musicPath,
      brandCorner: ctx.config.brandCorner,
    }

    await ctx.artifacts.write('videoSpec', VideoSpecSchema, spec)

    const renderer = deps.renderer ?? createChildProcessRenderer({ repoRoot })
    const outPath = path.join(ctx.paths.out, 'video.mp4')
    await renderer.renderVideo(spec, outPath)

    const rawThumbnails = await discoverRawThumbnails(ctx.paths.thumbnail)
    if (rawThumbnails.length > 0) {
      const jobs: ThumbnailJob[] = rawThumbnails.map((sourceImagePath) => ({
        sourceImagePath,
        outPath: finalThumbnailPath(sourceImagePath),
        title: seo.chosenTitle,
        width: THUMBNAIL_WIDTH,
        height: THUMBNAIL_HEIGHT,
      }))
      await renderer.renderThumbnails(jobs)
    } else {
      ctx.log.warn('no raw hero images found; skipping thumbnail compositing', { stage: 'editor' })
    }

    ctx.log.info(`rendered ${scenes.length} scenes (${cursor}s) to ${outPath}`, { stage: 'editor' })
    return { status: 'done' }
  },
})
