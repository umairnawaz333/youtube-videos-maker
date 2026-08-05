import React from 'react'
import type { BrandCornerPosition } from '../types'

const POSITION_STYLE: Record<BrandCornerPosition, React.CSSProperties> = {
  'bottom-right': { bottom: 16, right: 16 },
  'bottom-left': { bottom: 16, left: 16 },
  'top-right': { top: 16, right: 16 },
  'top-left': { top: 16, left: 16 },
}

export interface BrandCornerProps {
  enabled: boolean
  position: BrandCornerPosition
}

/**
 * A consistent branded corner element drawn on every scene, clip and image alike (spec
 * section 11: "a badge that appears during clip scenes and disappears during SDXL scenes
 * reads as a defect"). Deliberately drawn at the same position on every frame regardless of
 * whether the current scene is a Veo clip, so the layout never signals which scenes came
 * from where.
 */
export const BrandCorner: React.FC<BrandCornerProps> = ({ enabled, position }) => {
  if (!enabled) return null

  return (
    <div
      style={{
        position: 'absolute',
        ...POSITION_STYLE[position],
        width: 88,
        height: 32,
        borderRadius: 6,
        backgroundColor: 'rgba(0,0,0,0.55)',
        color: 'white',
        fontFamily: 'sans-serif',
        fontSize: 14,
        fontWeight: 700,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        letterSpacing: 1,
      }}
    >
      BRAND
    </div>
  )
}
