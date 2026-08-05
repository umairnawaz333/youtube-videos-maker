import { ensureStyleSuffix } from './illustrator'

/**
 * Appended to a scene's own image prompt so hero candidates favour a single readable subject
 * over the busier composition a narrative b-roll image can get away with (design spec, section
 * 4, stage 8: "high contrast, large readable type, a single clear subject, and minimal
 * clutter" — the text overlay itself is Remotion's job at render time, not this stage's).
 */
export const HERO_STYLE_HINT =
  'thumbnail hero shot, single bold clear subject, high contrast, dramatic lighting, minimal clutter'

/** Builds the SD prompt for one thumbnail candidate from an existing scene's image prompt. */
export const buildHeroPrompt = (scenePrompt: string, styleSuffix: string): string =>
  ensureStyleSuffix(`${scenePrompt}, ${HERO_STYLE_HINT}`, styleSuffix)
