import { describe, expect, it, vi } from 'vitest'
import { WikipediaResearchProvider } from '@yt/providers'

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('WikipediaResearchProvider', () => {
  it('splits a summary into sentence-level facts, each carrying the page URL', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        title: 'Venus',
        extract: 'Venus is the second planet from the Sun. It rotates in the opposite direction to most planets. Its day is longer than its year.',
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Venus' } },
      }),
    ) as unknown as typeof fetch

    const facts = await new WikipediaResearchProvider({ fetchImpl }).lookup('Venus')

    expect(facts).toHaveLength(3)
    expect(facts[0]!.text).toBe('Venus is the second planet from the Sun.')
    expect(facts.every((f) => f.sourceUrl === 'https://en.wikipedia.org/wiki/Venus')).toBe(true)
  })

  it('respects maxFacts', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        title: 'Venus',
        extract:
          'Alpha appears first in the list. Beta comes right after alpha. Gamma follows beta in turn. Delta is the fourth entry here. Epsilon closes the list at last.',
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Venus' } },
      }),
    ) as unknown as typeof fetch

    const facts = await new WikipediaResearchProvider({ fetchImpl }).lookup('Venus', { maxFacts: 2 })

    expect(facts).toHaveLength(2)
  })

  it('returns an empty array when the page does not exist, rather than throwing', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch

    await expect(new WikipediaResearchProvider({ fetchImpl }).lookup('Nonexistent')).resolves.toEqual([])
  })

  it('discards fragments too short to be a usable fact', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        title: 'Venus',
        extract: 'Venus is the second planet from the Sun. Yes. It rotates backwards compared with most planets.',
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Venus' } },
      }),
    ) as unknown as typeof fetch

    const facts = await new WikipediaResearchProvider({ fetchImpl }).lookup('Venus')

    expect(facts.map((f) => f.text)).not.toContain('Yes.')
  })

  it('falls back to a constructed URL when the response omits content_urls', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ title: 'Venus', extract: 'Venus is the second planet from the Sun.' }),
    ) as unknown as typeof fetch

    const facts = await new WikipediaResearchProvider({ fetchImpl }).lookup('Venus')

    expect(facts[0]!.sourceUrl).toMatch(/^https:\/\/en\.wikipedia\.org\/wiki\//)
  })
})
