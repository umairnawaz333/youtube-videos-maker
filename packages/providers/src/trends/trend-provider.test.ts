import { describe, expect, it, vi } from 'vitest'
import { HttpTrendProvider, slugifyKey, type SourceFetcher } from '@yt/providers'
import type { TopicCandidate } from '@yt/core'

const candidate = (title: string, source: TopicCandidate['source']): TopicCandidate => ({
  key: slugifyKey(title),
  title,
  source,
  url: null,
})

describe('slugifyKey', () => {
  it('produces a stable lowercase slug', () => {
    expect(slugifyKey('Why Venus Rotates Backwards')).toBe('why-venus-rotates-backwards')
  })

  it('strips punctuation and collapses separators', () => {
    expect(slugifyKey('  The "Great" Attractor: what is it?! ')).toBe('the-great-attractor-what-is-it')
  })

  it('is identical for titles differing only in case or spacing', () => {
    expect(slugifyKey('Deep  Sea   Vents')).toBe(slugifyKey('deep sea vents'))
  })
})

describe('HttpTrendProvider', () => {
  it('returns candidates only from the requested sources', async () => {
    const fetchers: Partial<Record<TopicCandidate['source'], SourceFetcher>> = {
      hackernews: async () => [candidate('An HN story', 'hackernews')],
      arxiv: async () => [candidate('A paper', 'arxiv')],
    }
    const provider = new HttpTrendProvider({ fetchers })

    const got = await provider.fetchCandidates(['hackernews'])

    expect(got.map((c) => c.title)).toEqual(['An HN story'])
  })

  it('merges candidates across several sources', async () => {
    const fetchers: Partial<Record<TopicCandidate['source'], SourceFetcher>> = {
      hackernews: async () => [candidate('An HN story', 'hackernews')],
      arxiv: async () => [candidate('A paper', 'arxiv')],
    }
    const provider = new HttpTrendProvider({ fetchers })

    const got = await provider.fetchCandidates(['hackernews', 'arxiv'])

    expect(got).toHaveLength(2)
  })

  it('survives one source failing and still returns the others', async () => {
    const log = vi.fn<(message: string) => void>()
    const fetchers: Partial<Record<TopicCandidate['source'], SourceFetcher>> = {
      hackernews: async () => {
        throw new Error('network down')
      },
      arxiv: async () => [candidate('A paper', 'arxiv')],
    }
    const provider = new HttpTrendProvider({ fetchers, log })

    const got = await provider.fetchCandidates(['hackernews', 'arxiv'])

    expect(got.map((c) => c.title)).toEqual(['A paper'])
    expect(log.mock.calls[0]![0]).toMatch(/hackernews/)
  })

  it('deduplicates candidates that different sources both surfaced', async () => {
    const fetchers: Partial<Record<TopicCandidate['source'], SourceFetcher>> = {
      hackernews: async () => [candidate('Deep sea vents', 'hackernews')],
      reddit: async () => [candidate('deep  sea  vents', 'reddit')],
    }
    const provider = new HttpTrendProvider({ fetchers })

    const got = await provider.fetchCandidates(['hackernews', 'reddit'])

    expect(got).toHaveLength(1)
  })

  it('returns an empty array when no source yields anything, rather than throwing', async () => {
    const provider = new HttpTrendProvider({ fetchers: { arxiv: async () => [] } })
    await expect(provider.fetchCandidates(['arxiv'])).resolves.toEqual([])
  })
})
