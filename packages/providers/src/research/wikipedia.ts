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
  pages?: { title?: string }[]
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
   * search itself fails or finds nothing. A local model asked for "encyclopedia article
   * titles" reliably names the right general subject but routinely phrases it differently
   * from the actual page title ("Rocket Propulsion Systems" for the real "Spacecraft
   * propulsion", "NASA's Artemis Program" for the real "Artemis program") — confirmed against
   * a real run where every one of six plausible, genuinely-existing entities 404'd on an exact
   * title match. Wikipedia's own search does the fuzzy matching instead of us guessing at it.
   */
  private async searchTitle(query: string): Promise<string | null> {
    const url = `https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=1`

    try {
      const res = await this.fetchImpl(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      })
      if (!res.ok) {
        this.log?.(`Wikipedia search for "${query}" returned ${res.status}`)
        return null
      }
      const body = (await res.json()) as SearchResponse
      return body.pages?.[0]?.title ?? null
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
        if (body) resolvedQuery = found
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
