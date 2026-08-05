import { z } from 'zod'
import { CAMERA_MOVES, VIDEO_FORMATS } from '../domain'
import {
  CaptionWordSchema,
  CaptionWordsFileSchema,
  type CaptionWordEntry,
  type CaptionWordsFile,
} from './audio'
import { BrandCornerSchema } from './config'

/**
 * `captions/words.json` — written by the Captioner, read by the Editor.
 *
 * Deliberately an alias rather than a second definition. The audio and render blocks were built
 * in parallel and each declared its own schema for this file; they happened to agree, but two
 * independent descriptions of one file on disk is precisely how the thumbnail naming drifted
 * (raw heroes written as `vN.png` while the compositor searched for `raw-vN.png`). The writer
 * owns the contract, so `schemas/audio.ts` is the single source of truth and the renderer reads
 * through it.
 */
export const RenderCaptionWordSchema = CaptionWordSchema
export type RenderCaptionWord = CaptionWordEntry

export const CaptionsFileSchema = CaptionWordsFileSchema
export type CaptionsFile = CaptionWordsFile

/**
 * A scene's visual, resolved to concrete render inputs. Distinct from `SceneVisualSchema` in
 * `content.ts`: that schema is the ScenePlanner's *intent* (a prompt, a reference id, a
 * fallback prompt); this is what is actually on disk by the time the Editor renders — a
 * scene never reaches the renderer still asking "which one, image or clip?". Resolving that
 * ambiguity (did the clip arrive? did ClipGate skip it?) is the Editor's job, not the
 * renderer's, which is what keeps the renderer a pure function of this file alone.
 */
export const RenderSceneVisualSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), path: z.string().min(1) }),
  z.object({
    kind: z.literal('motion-graphic'),
    variant: z.enum(['timeline', 'map', 'stat', 'quote', 'list']),
    payload: z.record(z.unknown()),
  }),
  z.object({ kind: z.literal('clip'), path: z.string().min(1), fallbackImagePath: z.string().min(1) }),
])
export type RenderSceneVisual = z.infer<typeof RenderSceneVisualSchema>

export const RenderSceneSchema = z.object({
  id: z.string().min(1),
  /** Seconds from the start of the whole video — the Sequence offset Remotion needs. */
  startSec: z.number().nonnegative(),
  durationSec: z.number().positive(),
  text: z.string(),
  visual: RenderSceneVisualSchema,
  camera: z.enum(CAMERA_MOVES),
  audioPath: z.string().min(1),
})
export type RenderScene = z.infer<typeof RenderSceneSchema>

/**
 * The single file the renderer is a pure function of (spec section 3 and 12). Everything the
 * render needs — scenes, exact timings, asset paths, captions, format — lives here, so a
 * render can be reproduced or retried without touching an AI model. The Editor stage is what
 * assembles this from `scenes.json`, `seo.json`, the audio/caption files on disk, and config;
 * the renderer itself never reads those directly.
 */
export const VideoSpecSchema = z
  .object({
    runId: z.string().min(1),
    format: z.enum(VIDEO_FORMATS),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
    durationSec: z.number().positive(),
    title: z.string().min(1),
    scenes: z.array(RenderSceneSchema).min(1),
    /** Video-relative word timings, concatenated across every scene's narration. */
    captions: z.array(RenderCaptionWordSchema),
    /** Absolute path into `assets/music/`, or null when no track matched — music is optional. */
    musicPath: z.string().nullable(),
    brandCorner: BrandCornerSchema,
  })
  .superRefine((value, ctx) => {
    const total = value.scenes.reduce((sum, s) => sum + s.durationSec, 0)
    // 0.5s of slack absorbs floating-point rounding across dozens of scenes without masking a
    // real mismatch between the declared total and what the scenes actually add up to.
    if (Math.abs(total - value.durationSec) > 0.5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['durationSec'],
        message: `durationSec (${value.durationSec}) does not match the sum of scene durations (${total})`,
      })
    }
  })
export type VideoSpec = z.infer<typeof VideoSpecSchema>

/**
 * One hero image needing its text overlay composited as a still. Not persisted as an
 * artifact — the Editor builds these in memory from `thumbnail/raw-v*.png` and the chosen
 * title, and hands them straight to the renderer seam.
 */
export const ThumbnailJobSchema = z.object({
  sourceImagePath: z.string().min(1),
  outPath: z.string().min(1),
  title: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
})
export type ThumbnailJob = z.infer<typeof ThumbnailJobSchema>
