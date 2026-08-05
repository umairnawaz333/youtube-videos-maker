import React from 'react'
import { AbsoluteFill, Img } from 'remotion'
import type { ThumbnailJob } from '../types'

export interface ThumbnailStillProps {
  job: ThumbnailJob
}

/**
 * Composites one hero image with its title text overlay as a still (spec section 4:
 * "Remotion composites the text overlay as a still"). This belongs to the render block, not
 * the image agent — the Thumbnailer stage only produces the five raw SDXL hero images
 * (`thumbnail/raw-v1.png` .. `raw-v5.png`); the Editor stage renders this composition once
 * per raw image to produce the final `thumbnail/v1.png` .. `v5.png`.
 *
 * Optimises for the spec's stated goals: high contrast, large readable type, a single clear
 * subject left mostly unobstructed, minimal clutter — a bottom title band rather than text
 * laid directly over the subject.
 */
export const ThumbnailStill: React.FC<ThumbnailStillProps> = ({ job }) => (
  <AbsoluteFill>
    <Img src={job.sourceImagePath} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
    <AbsoluteFill
      style={{
        justifyContent: 'flex-end',
        background: 'linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.0) 55%)',
      }}
    >
      <div
        style={{
          padding: '5% 6%',
          fontFamily: 'sans-serif',
          fontWeight: 900,
          fontSize: Math.round(job.height * 0.11),
          lineHeight: 1.05,
          color: 'white',
          textShadow: '0 4px 18px rgba(0,0,0,0.9)',
          maxWidth: '92%',
        }}
      >
        {job.title}
      </div>
    </AbsoluteFill>
  </AbsoluteFill>
)
