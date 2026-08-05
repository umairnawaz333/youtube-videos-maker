import type { ResearchFact, ResearchProvider } from '@yt/core'

const USER_AGENT = 'ai-youtube-factory/0.1 (local, personal use)'

/** Below this length a fragment is an artefact of naive splitting, not a fact. */
const MIN_FACT_CHARS = 25

interface SummaryResponse {
  title?: string
  extract?: string
  content_urls?: { desktop?: { page?: string } }
}

interface SearchResponse {
  pages?: { title?: string; description?: string }[]
}

/**
 * Connector words carry no relevance signal, so they are stripped before comparing a query to
 * a candidate page — otherwise a shared "the" or "of" would count as a match.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is', 'are', 'was', 'were',
  'this', 'that', 'these', 'those', 'with', 'from', 'about', 'its', 'into', 'over', 'under', 'as',
  'by', 'be', 'it', 'than', 'then', 'so', 'if', 'not',
])

/** How many of Wikipedia's own top search results are considered before giving up. */
const SEARCH_RESULTS_CONSIDERED = 5

/**
 * Below this many shared, meaningful tokens between the query and a candidate's title +
 * description, a search hit is noise rather than a genuine match — the bar every candidate in
 * a real run failed to clear when "NASA's PUNCH Sharpens Solar Storm Forecasting in First
 * Test" resolved to "Brown dwarf".
 */
const MIN_TOKEN_OVERLAP = 1

/** Lowercases, strips a trailing possessive, and splits into meaningful words. */
const tokenize = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .replace(/['’]s\b/g, '')
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 0 && !STOPWORDS.has(token)),
  )

const overlapCount = (a: Set<string>, b: Set<string>): number => {
  let count = 0
  for (const token of a) {
    if (b.has(token)) count++
  }
  return count
}

/**
 * Grounding facts from Wikipedia's REST summary endpoint. Facts are sentence-level on
 * purpose: the fact checker later matches an individual claim against an individual fact, so
 * a single blob of prose would make that check meaningless.
 */
export class WikipediaResearchProvider implements ResearchProvider {
  private readonly fetchImpl: typeof fetch
  private readonly log?: (message: string) => void

  constructor(deps: { fetchImpl?: typeof fetch; log?: (message: string) => void } = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.log = deps.log
  }

  private async fetchSummary(query: string): Promise<SummaryResponse | null> {
    const slug = encodeURIComponent(query.trim().replace(/\s+/g, '_'))
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`

    try {
      const res = await this.fetchImpl(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      })
      if (!res.ok) {
        this.log?.(`no Wikipedia summary for "${query}" (${res.status})`)
        return null
      }
      return (await res.json()) as SummaryResponse
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.log?.(`Wikipedia lookup for "${query}" failed: ${detail}`)
      return null
    }
  }

  /**
   * Resolves a query to the title of Wikipedia's best-matching real article, or null if the
   * search itself fails, finds nothing, or finds nothing relevant. A local model asked for
   * "encyclopedia article titles" reliably names the right general subject but routinely
   * phrases it differently from the actual page title ("Rocket Propulsion Systems" for the
   * real "Spacecraft propulsion", "NASA's Artemis Program" for the real "Artemis program") —
   * confirmed against a real run where every one of six plausible, genuinely-existing entities
   * 404'd on an exact title match. Wikipedia's own search does the fuzzy matching instead of us
   * guessing at it.
   *
   * But the raw top hit cannot be trusted blindly: a real run asked Wikipedia to search for the
   * topic's news-headline title and got back "Brown dwarf" — a real, well-documented, and
   * completely unrelated page — as its only result. So every candidate is gated on a token
   * overlap check between the query and the candidate's title + description before being
   * accepted, walked in Wikipedia's own rank order (not re-sorted by overlap score): Wikipedia's
   * relevance ranking is trusted as the primary signal — it correctly puts the genuine "NASA's
   * PUNCH Mission" -> "Polarimeter to Unify the Corona and Heliosphere" match first even though
   * the two share no title words at all, only "NASA" in the description — and the overlap
   * check exists purely to veto a top rank that is noise, not to pick a "better-scoring" lower
   * rank instead (a naive highest-overlap-wins rule would have preferred "Magnetospheric
   * Multiscale Mission" here, which shares "NASA" and "Mission" with the query by coincidence
   * but is the wrong spacecraft entirely).
   */
  private async searchTitle(query: string): Promise<string | null> {
    const url = `https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=${SEARCH_RESULTS_CONSIDERED}`

    try {
      const res = await this.fetchImpl(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      })
      if (!res.ok) {
        this.log?.(`Wikipedia search for "${query}" returned ${res.status}`)
        return null
      }
      const body = (await res.json()) as SearchResponse
      const pages = body.pages ?? []
      if (pages.length === 0) {
        this.log?.(`Wikipedia search for "${query}" returned no results`)
        return null
      }

      const queryTokens = tokenize(query)
      for (const page of pages) {
        if (!page.title) continue
        const candidateTokens = tokenize(`${page.title} ${page.description ?? ''}`)
        if (overlapCount(queryTokens, candidateTokens) >= MIN_TOKEN_OVERLAP) {
          return page.title
        }
      }

      // Every candidate Wikipedia's own ranking offered was unrelated to the query. Accepting
      // the top one anyway is exactly how "NASA's PUNCH Sharpens Solar Storm Forecasting in
      // First Test" resolved to "Brown dwarf" in a real run. A rejected lookup contributes no
      // facts, same as a 404 — but unlike a 404 it is otherwise silent, so it is logged with
      // both the query and what was rejected.
      const rejected = pages.map((p) => p.title).filter((t): t is string => Boolean(t))
      this.log?.(
        `rejected all ${rejected.length} Wikipedia search result(s) for "${query}" as unrelated: ${rejected.join(', ')}`,
      )
      return null
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.log?.(`Wikipedia search for "${query}" failed: ${detail}`)
      return null
    }
  }

  async lookup(query: string, opts?: { maxFacts?: number }): Promise<ResearchFact[]> {
    let resolvedQuery = query.trim()
    let body = await this.fetchSummary(resolvedQuery)

    // A local model asked for "encyclopedia article titles" routinely appends a common
    // abbreviation in parentheses ("Lunar Reconnaissance Orbiter (LRO)") even when the real
    // Wikipedia page has no such suffix — confirmed against a real run, where this was the
    // only thing standing between a genuinely well-documented, correctly-named entity and a
    // 404. One retry on the bare name (stripping a trailing "(...)") costs nothing when the
    // first lookup already succeeded, and recovers exactly that case when it didn't.
    if (!body) {
      const withoutParenthetical = resolvedQuery.replace(/\s*\([^)]*\)\s*$/, '')
      if (withoutParenthetical !== resolvedQuery && withoutParenthetical.length > 0) {
        body = await this.fetchSummary(withoutParenthetical)
        if (body) resolvedQuery = withoutParenthetical
      }
    }

    // Last resort: let Wikipedia's own search resolve the model's phrasing to whatever the
    // real page is actually titled.
    if (!body) {
      const found = await this.searchTitle(resolvedQuery)
      if (found) {
        body = await this.fetchSummary(found)
        if (body) {
          // A successful substitution is otherwise silent — only a failed search or fetch
          // logs anything — and the researcher above only logs the model's original entity
          // name, not the page actually read. Without this, grounding facts can enter
          // research.facts from a page nobody can trace back to what the model asked for.
          this.log?.(`resolved "${resolvedQuery}" to Wikipedia page "${found}" via search`)
          resolvedQuery = found
        }
      }
    }

    if (!body) return []

    const extract = body.extract ?? ''
    if (extract.trim().length === 0) return []

    const slug = encodeURIComponent(resolvedQuery.replace(/\s+/g, '_'))
    const sourceUrl = body.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${slug}`

    // Split on sentence boundaries followed by whitespace and a capital letter, which avoids
    // breaking on decimals and common abbreviations.
    const sentences = extract
      .split(/(?<=[.!?])\s+(?=[A-Z(])/)
      .map((s) => s.trim())
      .filter((s) => s.length >= MIN_FACT_CHARS)

    const limit = opts?.maxFacts ?? 8
    return sentences.slice(0, limit).map((text) => ({ text, sourceUrl }))
  }
}
