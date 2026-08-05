import type { CameraMove } from '../types'

/**
 * Ken Burns / parallax camera moves. `progress` is 0 at the scene's first frame and 1 at its
 * last, so every move is expressed purely as a function of scene-relative progress — no
 * global clock, which is what keeps a re-render of one scene's timing independent of every
 * other scene's.
 */
export const cameraTransform = (camera: CameraMove, progress: number): string => {
  const p = Math.min(1, Math.max(0, progress))

  switch (camera) {
    case 'zoom-in': {
      // 1.0 -> 1.12 across the scene: slow enough not to read as a jump cut, visible enough
      // to avoid the "static slideshow" look the spec calls out by name.
      const scale = 1 + 0.12 * p
      return `scale(${scale})`
    }
    case 'zoom-out': {
      const scale = 1.12 - 0.12 * p
      return `scale(${scale})`
    }
    case 'pan-left': {
      const scale = 1.12
      const translateX = 6 - 12 * p // percent, drifts from +6% to -6%
      return `scale(${scale}) translateX(${translateX}%)`
    }
    case 'pan-right': {
      const scale = 1.12
      const translateX = -6 + 12 * p
      return `scale(${scale}) translateX(${translateX}%)`
    }
    case 'parallax': {
      // Meant for a layered visual (background moves slower than foreground); applied here to
      // the single image/clip layer as a gentler combined pan+zoom so it still reads as
      // "depth" rather than a plain pan when there is only one layer to move.
      const scale = 1 + 0.08 * p
      const translateY = -4 + 8 * p
      return `scale(${scale}) translateY(${translateY}%)`
    }
    case 'still':
    default:
      return 'scale(1)'
  }
}
