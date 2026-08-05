import type { ResearchFact } from '@yt/core'
import { decodeEntities } from '../trends/sources'
import { splitIntoFactSentences } from './sentences'

const USER_AGENT = 'ai-youtube-factory/0.1 (local, personal use)'

/**
 * Below this many characters, a page's cleaned text is too thin to judge as real article
 * prose one way or the other — a paywall stub or a JS-only shell that rendered almost
 * nothing server-side lands here, and gets nothing extracted rather than a guess.
 */
const MIN_PROSE_CHARS = 200

/**
 * Real article prose carries roughly one sentence-ending mark every 15-25 words. A page that
 * is actually navigation, a cookie banner, or a link dump concatenated together — the exact
 * failure this guards against, since an earlier fix in this project had to undo grounding
 * facts poisoned by exactly that — reliably has far fewer periods per word than that, often
 * none at all. The threshold is deliberately generous (about one per 40 words) so genuine but
 * terse prose is not rejected, while a nav dump with no sentence punctuation at all still fails
 * it outright.
 */
const MIN_SENTENCE_PUNCTUATION_RATIO = 1 / 40

/**
 * Elements whose entire contents are never prose, regardless of what page they sit in — a
 * `<script type="application/ld+json">` block routinely embeds a page's own meta-description
 * as a JSON string, which reads like a plausible sentence but did not appear anywhere in the
 * article's actual body, and must never be mistaken for one.
 */
const NON_CONTENT_TAGS = /<(script|style|noscript|template|head)[^>]*>[\s\S]*?<\/\1>/gi

/**
 * Decides whether cleaned page text is worth mining for facts at all. Guards the exact failure
 * mode a real run had to undo elsewhere in this project: navigation boilerplate accepted as
 * "facts" because it was merely long enough, not because it read like prose. A page that fails
 * this check contributes nothing — not a poor-quality fact, no fact at all.
 */
export const looksLikeArticleProse = (text: string): boolean => {
  const trimmed = text.trim()
  if (trimmed.length < MIN_PROSE_CHARS) return false

  const words = trimmed.split(/\s+/).filter((w) => w.length > 0)
  if (words.length === 0) return false

  const sentenceEnders = (trimmed.match(/[.!?]/g) ?? []).length
  return sentenceEnders / words.length >= MIN_SENTENCE_PUNCTUATION_RATIO
}

/**
 * Reduces a raw HTML page down to the prose worth mining for facts, without adding an HTML
 * parser dependency — the same regex-based approach this project already uses to pull titles
 * out of RSS/Atom feeds (see `trends/sources.ts`). Non-content elements are stripped first and
 * entirely (contents included), since their text is never prose no matter where it sits. The
 * semantic `<article>` region is preferred when the page marks one — that is exactly the
 * content a news page's own template wraps the story in, as opposed to nav, footer, and
 * related-links chrome around it — falling back to `<main>` and finally the whole remaining
 * document. Any remaining tag becomes a space rather than nothing, so two adjoining block
 * elements are never glued into one run-on word or sentence.
 */
const htmlToProse = (html: string): string => {
  let text = html.replace(NON_CONTENT_TAGS, ' ')

  const article = text.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
  if (article) {
    text = article[1]!
  } else {
    const main = text.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    if (main) text = main[1]!
  }

  text = text.replace(/<[^>]+>/g, ' ')
  return decodeEntities(text).replace(/\s+/g, ' ').trim()
}

/**
 * Fetches grounding facts from one specific URL — a news topic's own source article, the
 * primary and often only citable source for claims about a current event that has no
 * Wikipedia article of its own (a headline is not encyclopedic content by the time it airs).
 * Reuses the same sentence-splitting and length filter Wikipedia extraction already applies,
 * so a "good fact" is one definition, not a second copy per source.
 *
 * Never throws: a fetch failure, a non-OK response, or content that does not look like real
 * article prose (paywalled, JS-only, or navigation boilerplate) all resolve to an empty array,
 * exactly like a Wikipedia 404 — one bad source must degrade the corpus, not the run.
 */
export const fetchSourceArticleFacts = async (
  url: string,
  opts: { fetchImpl?: typeof fetch; log?: (message: string) => void; maxFacts?: number } = {},
): Promise<ResearchFact[]> => {
  const fetchImpl = opts.fetchImpl ?? fetch

  let html: string
  try {
    const res = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT, accept: 'text/html' } })
    if (!res.ok) {
      opts.log?.(`source article fetch for "${url}" returned ${res.status}; skipped`)
      return []
    }
    html = await res.text()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    opts.log?.(`source article fetch for "${url}" failed and was skipped: ${detail}`)
    return []
  }

  const prose = htmlToProse(html)
  if (!looksLikeArticleProse(prose)) {
    opts.log?.(`source article at "${url}" did not look like real article prose; skipped rather than risk noise`)
    return []
  }

  const sentences = splitIntoFactSentences(prose, { maxFacts: opts.maxFacts })
  if (sentences.length === 0) {
    opts.log?.(`source article at "${url}" yielded no usable sentence-level facts; skipped`)
    return []
  }

  return sentences.map((text) => ({ text, sourceUrl: url }))
}
