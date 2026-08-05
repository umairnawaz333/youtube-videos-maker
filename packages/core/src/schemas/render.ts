import { z } from 'zod'
import { CAMERA_MOVES, VIDEO_FORMATS } from '../domain'
import { BrandCornerSchema } from './config'

/**
 * One word with its measured timing, in seconds from the start of the whole video (not the
 * scene). Matches `CaptionProvider`'s `CaptionWord` shape in `providers.ts`, but that
 * interface returns per-clip words; this is the assembled, video-relative track the renderer
 * actually consumes.
 */
export const RenderCaptionWordSchema = z.object({
  word: z.string().min(1),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
})
export type RenderCaptionWord = z.infer<typeof RenderCaptionWordSchema>

/**
 * Contract for `captions/words.json`, written by the Captioner stage (Plan 4 audio block).
 * Kept here — rather than assumed inline by the Editor — so the boundary between stages is
 * one visible type instead of an implicit file shape.
 */
export const CaptionsFileSchema = z.object({
  words: z.array(RenderCaptionWordSchema),
})
export type CaptionsFile = z.infer<typeof CaptionsFileSchema>

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
