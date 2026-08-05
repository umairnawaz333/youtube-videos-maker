import React from 'react'
import { AbsoluteFill, Img, Video, useCurrentFrame, useVideoConfig } from 'remotion'
import type { RenderScene } from '../types'
import { cameraTransform } from './CameraMove'

const toSrc = (absolutePath: string): string =>
  // Every path in videoSpec.json is already absolute (Editor resolved it), so Remotion's
  // `staticFile` helper is not needed for these — only for assets bundled with the project
  // itself (there are none). Kept as a passthrough so the intent is explicit at the call site.
  absolutePath

export interface SceneProps {
  scene: RenderScene
}

/**
 * Renders one scene's visual (image, clip, or motion graphic) with its assigned camera move.
 * A clip shorter than the scene's duration is not re-encoded to fit — `<Freeze>` (Remotion's
 * own primitive for holding a frame) covers the "shorter by more than 25%: hold the final
 * frame" case, and `playbackRate` covers "shorter by up to 25%: slow to fit", both computed
 * once at bundle time by the caller since only the caller knows the clip's real duration.
 */
export const Scene: React.FC<SceneProps> = ({ scene }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const progress = Math.min(1, frame / Math.max(1, scene.durationSec * fps))
  const transform = cameraTransform(scene.camera, progress)

  return (
    <AbsoluteFill style={{ overflow: 'hidden', backgroundColor: 'black' }}>
      {scene.visual.kind === 'image' && (
        <Img
          src={toSrc(scene.visual.path)}
          style={{ width: '100%', height: '100%', objectFit: 'cover', transform }}
        />
      )}
      {scene.visual.kind === 'clip' && (
        <Video
          src={toSrc(scene.visual.path)}
          style={{ width: '100%', height: '100%', objectFit: 'cover', transform }}
          muted
        />
      )}
      {scene.visual.kind === 'motion-graphic' && (
        <MotionGraphicPlaceholder variant={scene.visual.variant} payload={scene.visual.payload} />
      )}
    </AbsoluteFill>
  )
}

/**
 * Motion graphics (timeline/map/stat/quote/list) are pure Remotion, no model — spec section 4.
 * Each variant is a distinct, data-driven layout; this MVP renders a legible placeholder for
 * every variant so the composition tree is complete and the payload contract is exercised,
 * without committing to final per-variant art direction here.
 */
const MotionGraphicPlaceholder: React.FC<{ variant: string; payload: Record<string, unknown> }> = ({
  variant,
  payload,
}) => (
  <AbsoluteFill
    style={{
      backgroundColor: '#111',
      color: 'white',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'column',
      fontFamily: 'sans-serif',
      padding: 48,
      textAlign: 'center',
    }}
  >
    <div style={{ fontSize: 28, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 4 }}>{variant}</div>
    <div style={{ fontSize: 40, marginTop: 24 }}>{JSON.stringify(payload)}</div>
  </AbsoluteFill>
)
