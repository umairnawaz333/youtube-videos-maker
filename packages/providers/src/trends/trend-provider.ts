import type { TopicCandidate, TrendProvider, TrendSource } from '@yt/core'
import { SOURCE_FETCHERS, type SourceFetcher } from './sources'

export class HttpTrendProvider implements TrendProvider {
  private readonly fetchImpl: typeof fetch
  private readonly fetchers: Record<TrendSource, SourceFetcher>

  constructor(deps: {
    fetchImpl?: typeof fetch
    fetchers?: Partial<Record<TrendSource, SourceFetcher>>
    log?: (message: string) => void
  } = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.fetchers = { ...SOURCE_FETCHERS, ...deps.fetchers }
    this.log = deps.log
  }

  private readonly log?: (message: string) => void

  /**
   * One source failing must not fail the fetch — a run should not die because a public
   * endpoint was briefly unavailable. Failures are logged and the rest are returned.
   */
  async fetchCandidates(sources: readonly TrendSource[]): Promise<TopicCandidate[]> {
    const results = await Promise.all(
      sources.map(async (source) => {
        try {
          return await this.fetchers[source](this.fetchImpl)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          this.log?.(`trend source '${source}' failed and was skipped: ${detail}`)
          return []
        }
      }),
    )

    // Two sources often surface the same subject; the first one wins.
    const byKey = new Map<string, TopicCandidate>()
    for (const candidate of results.flat()) {
      if (!byKey.has(candidate.key)) byKey.set(candidate.key, candidate)
    }
    return [...byKey.values()]
  }
}
