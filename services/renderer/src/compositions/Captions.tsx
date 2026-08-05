import React from 'react'
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion'
import type { RenderCaptionWord } from '../types'

export interface CaptionsProps {
  words: RenderCaptionWord[]
  /** Video-relative frame is converted by the caller; this receives absolute seconds. */
  currentTimeSec: number
  fontSize: number
}

/** How many seconds of context are considered "current" around the active word, for the
 * small pop-in/out scale animation rather than a hard cut between words. */
const WORD_ANIMATION_SEC = 0.15

/**
 * Word-by-word animated captions, driven by the same `words[]` timing Captioner measured
 * from the narration — spec: "driving word-by-word animated captions in Remotion". Shows a
 * short rolling window around the current word so a viewer keeps reading context rather than
 * one word alone.
 */
export const Captions: React.FC<CaptionsProps> = ({ words, currentTimeSec, fontSize }) => {
  const activeIndex = words.findIndex((w) => currentTimeSec >= w.startSec && currentTimeSec < w.endSec)
  if (activeIndex === -1) return null

  const windowStart = Math.max(0, activeIndex - 3)
  const windowEnd = Math.min(words.length, activeIndex + 4)
  const visible = words.slice(windowStart, windowEnd)

  return (
    <AbsoluteFill
      style={{
        justifyContent: 'flex-end',
        alignItems: 'center',
        paddingBottom: '14%',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          gap: '0.4em',
          maxWidth: '85%',
          fontFamily: 'sans-serif',
          fontWeight: 800,
          fontSize,
          textShadow: '0 2px 12px rgba(0,0,0,0.85)',
          color: 'white',
        }}
      >
        {visible.map((word, i) => {
          const globalIndex = windowStart + i
          const isActive = globalIndex === activeIndex
          const sinceStart = currentTimeSec - word.startSec
          const pop = isActive
            ? interpolate(sinceStart, [0, WORD_ANIMATION_SEC], [0.7, 1], { extrapolateRight: 'clamp' })
            : 1
          return (
            <span
              key={`${word.word}-${globalIndex}`}
              style={{
                opacity: isActive ? 1 : 0.55,
                transform: `scale(${pop})`,
                color: isActive ? '#ffd23f' : 'white',
              }}
            >
              {word.word}
            </span>
          )
        })}
      </div>
    </AbsoluteFill>
  )
}

/** Convenience wrapper matching Remotion's own frame-based clock, for use inside MainVideo. */
export const CaptionsAtFrame: React.FC<{ words: RenderCaptionWord[]; fps: number; fontSize: number }> = ({
  words,
  fps,
  fontSize,
}) => {
  const frame = useCurrentFrame()
  return <Captions words={words} currentTimeSec={frame / fps} fontSize={fontSize} />
}
