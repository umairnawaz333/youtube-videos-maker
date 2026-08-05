import type { ResearchFact } from '@yt/core'

/**
 * Bounds how many gathered facts a single prompt lists. The script writer and the fact-checker
 * must see the exact same slice: the writer is only allowed to state what its facts support, and
 * if the checker were shown a different (e.g. shorter) slice, a claim genuinely grounded in a
 * fact outside the checker's view would be marked unsupported through no fault of the narration.
 * Deriving the slice here once — rather than each stage re-slicing `research.facts` on its own —
 * makes that mismatch impossible to introduce by drift between the two call sites.
 *
 * The corpus is ordered source-article-first, then Wikipedia background per entity (see
 * researcher.ts, which pushes the topic's own source article's facts before any `lookup` call),
 * so a leading slice keeps the facts most tightly bound to the actual video subject rather than
 * an arbitrary subset — the long tail dropped is the background material a small model would be
 * least likely to draw on anyway.
 */
export const selectFactsForPrompt = (facts: readonly ResearchFact[], cap: number): ResearchFact[] =>
  facts.slice(0, cap)
