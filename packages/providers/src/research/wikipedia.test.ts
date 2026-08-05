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

  it('retries without a trailing parenthetical when the exact title 404s', async () => {
    // Reproduces a real qwen3:8b research entity: "Lunar Reconnaissance Orbiter (LRO)" 404s,
    // but the actual Wikipedia page — "Lunar Reconnaissance Orbiter" — exists.
    const requested: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(decodeURIComponent(url))
      if (url.includes('LRO')) return new Response('', { status: 404 })
      return jsonResponse({
        title: 'Lunar Reconnaissance Orbiter',
        extract: 'The Lunar Reconnaissance Orbiter is a NASA robotic spacecraft.',
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Lunar_Reconnaissance_Orbiter' } },
      })
    }) as unknown as typeof fetch

    const facts = await new WikipediaResearchProvider({ fetchImpl }).lookup(
      'Lunar Reconnaissance Orbiter (LRO)',
    )

    expect(facts).toHaveLength(1)
    expect(requested).toHaveLength(2)
    expect(requested[1]).toContain('Lunar_Reconnaissance_Orbiter')
  })

  it('does not retry when the exact title already succeeded', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        title: 'Venus',
        extract: 'Venus is the second planet from the Sun.',
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Venus' } },
      }),
    ) as unknown as typeof fetch

    await new WikipediaResearchProvider({ fetchImpl }).lookup('Venus (planet)')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('falls all the way through to an empty result when nothing resolves, search included', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch

    const facts = await new WikipediaResearchProvider({ fetchImpl }).lookup('Nonexistent Entity')

    expect(facts).toEqual([])
  })

  it('resolves via Wikipedia search when the model\'s phrasing does not match the real title', async () => {
    // Reproduces a real qwen3:8b research entity: "Rocket Propulsion Systems" 404s outright
    // (no parenthetical to strip either), but the real page — "Spacecraft propulsion" — exists
    // and is exactly what Wikipedia's own search resolves it to.
    const requested: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(decodeURIComponent(url))
      if (url.includes('/search/page')) {
        return jsonResponse({ pages: [{ title: 'Spacecraft propulsion' }] })
      }
      if (url.includes('Spacecraft_propulsion')) {
        return jsonResponse({
          title: 'Spacecraft propulsion',
          extract: 'Spacecraft propulsion is any method used to accelerate spacecraft.',
          content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Spacecraft_propulsion' } },
        })
      }
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch

    const facts = await new WikipediaResearchProvider({ fetchImpl }).lookup('Rocket Propulsion Systems')

    expect(facts).toHaveLength(1)
    expect(facts[0]!.sourceUrl).toBe('https://en.wikipedia.org/wiki/Spacecraft_propulsion')
    expect(requested.some((u) => u.includes('/search/page'))).toBe(true)
  })

  it('logs a successful search substitution, naming both the query and the page it resolved to', async () => {
    // A successful substitution was previously silent — only a failed search logged anything —
    // so a hallucinated entity name could fuzzy-resolve to an unrelated real page with nothing
    // in the log to say it happened.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/search/page')) return jsonResponse({ pages: [{ title: 'Spacecraft propulsion' }] })
      if (url.includes('Spacecraft_propulsion')) {
        return jsonResponse({
          title: 'Spacecraft propulsion',
          extract: 'Spacecraft propulsion is any method used to accelerate spacecraft.',
          content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Spacecraft_propulsion' } },
        })
      }
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch
    const logged: string[] = []

    await new WikipediaResearchProvider({ fetchImpl, log: (m) => logged.push(m) }).lookup(
      'Rocket Propulsion Systems',
    )

    const substitutionLog = logged.find((m) => m.includes('resolved'))
    expect(substitutionLog).toContain('Rocket Propulsion Systems')
    expect(substitutionLog).toContain('Spacecraft propulsion')
  })

  it('does not log a substitution when the exact title already succeeded', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        title: 'Venus',
        extract: 'Venus is the second planet from the Sun.',
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Venus' } },
      }),
    ) as unknown as typeof fetch
    const logged: string[] = []

    await new WikipediaResearchProvider({ fetchImpl, log: (m) => logged.push(m) }).lookup('Venus')

    expect(logged.some((m) => m.includes('resolved'))).toBe(false)
  })

  it('returns empty when the search endpoint itself finds nothing', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/search/page')) return jsonResponse({ pages: [] })
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch

    const facts = await new WikipediaResearchProvider({ fetchImpl }).lookup('Utterly Fabricated Thing')

    expect(facts).toEqual([])
  })

  it('does not fall through to search once the exact title already succeeded', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        title: 'Venus',
        extract: 'Venus is the second planet from the Sun.',
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Venus' } },
      }),
    ) as unknown as typeof fetch

    await new WikipediaResearchProvider({ fetchImpl }).lookup('Venus')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('falls back to a constructed URL when the response omits content_urls', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ title: 'Venus', extract: 'Venus is the second planet from the Sun.' }),
    ) as unknown as typeof fetch

    const facts = await new WikipediaResearchProvider({ fetchImpl }).lookup('Venus')

    expect(facts[0]!.sourceUrl).toMatch(/^https:\/\/en\.wikipedia\.org\/wiki\//)
  })
})
