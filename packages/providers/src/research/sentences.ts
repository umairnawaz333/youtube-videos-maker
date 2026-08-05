/**
 * Shared sentence-level fact extraction, used by every research source (a Wikipedia article's
 * full-text extract, and a news topic's own source article) so a "good fact" is judged by one
 * definition, not a parallel copy per source.
 */

/** Below this length a fragment is an artefact of naive splitting, not a fact. */
export const MIN_FACT_CHARS = 25

/**
 * Splits prose into sentence-level facts. Facts are sentence-level on purpose: the fact
 * checker later matches an individual claim against an individual fact, so a single blob of
 * prose would make that check meaningless. Splits on sentence boundaries followed by
 * whitespace and a capital letter, which avoids breaking on decimals and common abbreviations,
 * and drops any fragment too short to be a usable fact.
 */
export const splitIntoFactSentences = (prose: string, opts?: { maxFacts?: number }): string[] => {
  const sentences = prose
    .split(/(?<=[.!?])\s+(?=[A-Z(])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_FACT_CHARS)

  const limit = opts?.maxFacts ?? 8
  return sentences.slice(0, limit)
}
