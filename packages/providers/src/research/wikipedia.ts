import type { ResearchFact, ResearchProvider } from '@yt/core'

const USER_AGENT = 'ai-youtube-factory/0.1 (local, personal use)'

/** Below this length a fragment is an artefact of naive splitting, not a fact. */
const MIN_FACT_CHARS = 25

interface ExtractPage {
  title?: string
  extract?: string
  missing?: string
}

interface ExtractResponse {
  query?: { pages?: Record<string, ExtractPage> }
}

interface SearchResponse {
  pages?: { title?: string; description?: string }[]
}

/**
 * Section headings a full-article plaintext extract carries that a lead summary never does
 * (`prop=extracts&explaintext=1` marks them "== Heading ==", with more "=" per nesting level).
 * Everything from one of these onward is a link list or citation dump, not prose — the article
 * is truncated the moment one is reached rather than merely skipping the heading line itself.
 */
const STOP_SECTIONS = new Set([
  'see also',
  'references',
  'external links',
  'notes',
  'notes and references',
  'further reading',
  'bibliography',
  'sources',
  'citations',
  'footnotes',
  'gallery',
])

/** Matches a plaintext-extract heading line at any nesting depth, e.g. "== History ==". */
const HEADING_PATTERN = /^=+\s*(.+?)\s*=+$/

/**
 * Reduces a full-article plaintext extract to the prose worth turning into facts: heading
 * markers stripped (a heading names a section, it does not assert anything), the navigational
 * tail (see-also/references/external-links/...) truncated away entirely once reached, and blank
 * lines dropped. What remains is joined into one text and left to the same sentence splitter and
 * `MIN_FACT_CHARS` filter that already vet a lead summary, so a full article is not held to some
 * parallel, invented notion of a "good" sentence.
 */
const proseFromExtract = (extract: string): string => {
  const kept: string[] = []
  for (const rawLine of extract.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    const heading = line.match(HEADING_PATTERN)
    if (heading) {
      if (STOP_SECTIONS.has(heading[1]!.trim().toLowerCase())) break
      continue
    }
    kept.push(line)
  }
  return kept.join(' ')
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
 * Grounding facts from the full text of a Wikipedia article (`action=query&prop=extracts`),
 * not just its lead summary — a lead is two or three sentences, nowhere near enough to ground a
 * multi-beat script from a handful of entities, confirmed against a real run where five
 * genuinely relevant entities produced only nine usable facts total. Facts are sentence-level on
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

  /**
   * Fetches the full plaintext of an article, following Wikipedia's own redirects (`redirects=1`)
   * so e.g. "Venus (planet)" resolves to the real "Venus" the same way the REST summary endpoint
   * used to. Unlike that endpoint, a missing article is not an HTTP 404 — the action API answers
   * 200 with a synthetic `pageid: -1` page carrying a `missing` field — confirmed live, since an
   * earlier plan's assumption about this endpoint's shape turned out to be wrong.
   */
  private async fetchExtract(query: string): Promise<{ title: string; extract: string } | null> {
    const url =
      'https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1' +
      `&format=json&titles=${encodeURIComponent(query.trim())}`

    try {
      const res = await this.fetchImpl(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      })
      if (!res.ok) {
        this.log?.(`no Wikipedia article for "${query}" (${res.status})`)
        return null
      }
      const body = (await res.json()) as ExtractResponse
      const pages = Object.values(body.query?.pages ?? {})
      const page = pages[0]
      if (!page || page.missing !== undefined || !page.extract || page.extract.trim().length === 0) {
        this.log?.(`no Wikipedia article for "${query}" (404)`)
        return null
      }
      return { title: page.title ?? query, extract: page.extract }
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
    let page = await this.fetchExtract(resolvedQuery)

    // A local model asked for "encyclopedia article titles" routinely appends a common
    // abbreviation in parentheses ("Lunar Reconnaissance Orbiter (LRO)") even when the real
    // Wikipedia page has no such suffix — confirmed against a real run, where this was the
    // only thing standing between a genuinely well-documented, correctly-named entity and a
    // 404. One retry on the bare name (stripping a trailing "(...)") costs nothing when the
    // first lookup already succeeded, and recovers exactly that case when it didn't.
    if (!page) {
      const withoutParenthetical = resolvedQuery.replace(/\s*\([^)]*\)\s*$/, '')
      if (withoutParenthetical !== resolvedQuery && withoutParenthetical.length > 0) {
        page = await this.fetchExtract(withoutParenthetical)
        if (page) resolvedQuery = withoutParenthetical
      }
    }

    // Last resort: let Wikipedia's own search resolve the model's phrasing to whatever the
    // real page is actually titled.
    if (!page) {
      const found = await this.searchTitle(resolvedQuery)
      if (found) {
        page = await this.fetchExtract(found)
        if (page) {
          // A successful substitution is otherwise silent — only a failed search or fetch
          // logs anything — and the researcher above only logs the model's original entity
          // name, not the page actually read. Without this, grounding facts can enter
          // research.facts from a page nobody can trace back to what the model asked for.
          this.log?.(`resolved "${resolvedQuery}" to Wikipedia page "${found}" via search`)
          resolvedQuery = found
        }
      }
    }

    if (!page) return []

    // The page's own title (after action=query's redirects=1 resolution) is the canonical one —
    // not necessarily what was requested (e.g. "USA" resolves to "United States") — so the
    // source URL is built from it, the same way the REST endpoint's content_urls used to.
    const slug = encodeURIComponent(page.title.replace(/\s+/g, '_'))
    const sourceUrl = `https://en.wikipedia.org/wiki/${slug}`

    const prose = proseFromExtract(page.extract)

    // Split on sentence boundaries followed by whitespace and a capital letter, which avoids
    // breaking on decimals and common abbreviations.
    const sentences = prose
      .split(/(?<=[.!?])\s+(?=[A-Z(])/)
      .map((s) => s.trim())
      .filter((s) => s.length >= MIN_FACT_CHARS)

    const limit = opts?.maxFacts ?? 8
    return sentences.slice(0, limit).map((text) => ({ text, sourceUrl }))
  }
}
