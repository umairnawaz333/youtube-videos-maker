import type { ResearchFact, ResearchProvider } from '@yt/core'

const USER_AGENT = 'ai-youtube-factory/0.1 (local, personal use)'

/** Below this length a fragment is an artefact of naive splitting, not a fact. */
const MIN_FACT_CHARS = 25

interface SummaryResponse {
  title?: string
  extract?: string
  content_urls?: { desktop?: { page?: string } }
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

  async lookup(query: string, opts?: { maxFacts?: number }): Promise<ResearchFact[]> {
    const slug = encodeURIComponent(query.trim().replace(/\s+/g, '_'))
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`

    let body: SummaryResponse
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      })
      if (!res.ok) {
        this.log?.(`no Wikipedia summary for "${query}" (${res.status})`)
        return []
      }
      body = (await res.json()) as SummaryResponse
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.log?.(`Wikipedia lookup for "${query}" failed: ${detail}`)
      return []
    }

    const extract = body.extract ?? ''
    if (extract.trim().length === 0) return []

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
