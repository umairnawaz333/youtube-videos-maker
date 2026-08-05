/**
 * Fixed SDXL-Turbo generation resolution. Every image is generated square regardless of the
 * format preset; Remotion's camera moves (zoom, pan, parallax) crop this square canvas into
 * either aspect ratio at render time. See the design spec, section 4, stage 7 ("1024²").
 */
export const SDXL_IMAGE_SIZE = 1024

/**
 * Appends the niche's style suffix to a scene's own image prompt, unless it is already present.
 * The scene-planner's prompt is written by an LLM that is *asked* to append the suffix to every
 * prompt, but — same as the image/clip budgets scene-planner enforces in code rather than
 * trusting the model to respect them — a local model cannot be trusted to reliably comply, so
 * this stage enforces it directly instead of merely hoping the upstream prompt did.
 */
export const ensureStyleSuffix = (prompt: string, styleSuffix: string): string => {
  const trimmedSuffix = styleSuffix.trim()
  if (trimmedSuffix.length === 0) return prompt
  return prompt.toLowerCase().includes(trimmedSuffix.toLowerCase()) ? prompt : `${prompt}, ${trimmedSuffix}`
}

/**
 * Deterministic per-run base seed (FNV-1a, 32-bit), derived from the run id. Every sd-image
 * scene in a run generates from this same seed: combined with the niche style suffix, this is
 * what keeps a run's images feeling like one consistent piece rather than a slideshow of
 * unrelated styles (design spec, section 4, stage 7).
 */
export const deriveBaseSeed = (runId: string): number => {
  let hash = 0x811c9dc5
  for (let i = 0; i < runId.length; i++) {
    hash ^= runId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}
