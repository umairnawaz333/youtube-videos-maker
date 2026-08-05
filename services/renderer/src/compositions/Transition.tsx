import React from 'react'
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion'

/** Length of the cross-fade/blur that opens and closes every scene. */
const TRANSITION_SEC = 0.35

export interface TransitionWrapperProps {
  durationInFrames: number
  children: React.ReactNode
}

/**
 * Wraps a scene with the blur + fade transition the spec requires at every cut. Runs purely
 * on the scene's own local frame (0 at its first frame), so it composes cleanly inside a
 * Remotion `<Sequence>` without needing to know its absolute position in the timeline.
 */
export const TransitionWrapper: React.FC<TransitionWrapperProps> = ({ durationInFrames, children }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const transitionFrames = Math.round(TRANSITION_SEC * fps)

  const opacity = interpolate(
    frame,
    [0, transitionFrames, durationInFrames - transitionFrames, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  )
  const blurPx = interpolate(
    frame,
    [0, transitionFrames, durationInFrames - transitionFrames, durationInFrames],
    [8, 0, 0, 8],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  )

  return (
    <AbsoluteFill style={{ opacity, filter: `blur(${blurPx}px)` }}>
      {children}
    </AbsoluteFill>
  )
}
