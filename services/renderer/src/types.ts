/**
 * Mirrors the `VideoSpec` / `RenderScene` / `ThumbnailJob` shapes in
 * `packages/core/src/schemas/render.ts`.
 *
 * Duplicated rather than imported because `services/renderer` is not yet a pnpm workspace
 * member (`pnpm-workspace.yaml` only lists `apps/*` and `packages/*`) — see the render-block
 * report for why that file was left for the owner to change. Once `services/*` is added to
 * the workspace list and `@yt/core` is added as a dependency here, delete this file and
 * import the real types instead; keeping two copies in sync is a deliberate, temporary cost,
 * not a design intent.
 */

export type VideoFormat = 'shorts' | 'long'
export type CameraMove = 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right' | 'parallax' | 'still'
export type BrandCornerPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

export interface RenderCaptionWord {
  word: string
  startSec: number
  endSec: number
}

export type RenderSceneVisual =
  | { kind: 'image'; path: string }
  | { kind: 'motion-graphic'; variant: 'timeline' | 'map' | 'stat' | 'quote' | 'list'; payload: Record<string, unknown> }
  | { kind: 'clip'; path: string; fallbackImagePath: string }

export interface RenderScene {
  id: string
  startSec: number
  durationSec: number
  text: string
  visual: RenderSceneVisual
  camera: CameraMove
  audioPath: string
}

export interface VideoSpec {
  runId: string
  format: VideoFormat
  width: number
  height: number
  fps: number
  durationSec: number
  title: string
  scenes: RenderScene[]
  captions: RenderCaptionWord[]
  musicPath: string | null
  brandCorner: { enabled: boolean; position: BrandCornerPosition }
}

export interface ThumbnailJob {
  sourceImagePath: string
  outPath: string
  title: string
  width: number
  height: number
}
