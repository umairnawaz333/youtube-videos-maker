import React from 'react'
import { useCurrentFrame, useVideoConfig } from 'remotion'

/**
 * A thin bar across the bottom edge showing how far into the video the viewer is — one of
 * the four required effects (spec section 12). Purely a function of frame/durationInFrames,
 * so it needs no props beyond what Remotion already provides via context.
 */
export const ProgressBar: React.FC = () => {
  const frame = useCurrentFrame()
  const { durationInFrames } = useVideoConfig()
  const pct = Math.min(100, (frame / Math.max(1, durationInFrames - 1)) * 100)

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: 6,
        backgroundColor: 'rgba(255,255,255,0.18)',
      }}
    >
      <div style={{ width: `${pct}%`, height: '100%', backgroundColor: '#ffd23f' }} />
    </div>
  )
}
