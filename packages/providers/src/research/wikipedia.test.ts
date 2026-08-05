import { describe, expect, it, vi } from 'vitest'
import { WikipediaResearchProvider } from '@yt/providers'

/** Shapes a fixture the way `action=query&prop=extracts&explaintext=1&redirects=1` really replies —
 * confirmed live against en.wikipedia.org, not assumed: pages come back as an object keyed by
 * pageid, not an array, and there is no `content_urls` field at all (unlike the old REST summary
 * endpoint this replaces). */
const extractResponse = (title: string, extract: string): Response =>
  new Response(JSON.stringify({ query: { pages: { '123': { pageid: 123, ns: 0, title, extract } } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

/** A missing article is not an HTTP 404 on this endpoint — it is 200 OK with a synthetic
 * `pageid: -1` page carrying a `missing` field. Confirmed live: an earlier plan's assumption
 * about this endpoint's shape turned out to be wrong, so this fixture mirrors what was observed,
 * not what seemed plausible. */
const missingResponse = (title: string): Response =>
  new Response(JSON.stringify({ query: { pages: { '-1': { ns: 0, title, missing: '' } } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const searchResponse = (pages: { title?: string; description?: string }[]): Response =>
  new Response(JSON.stringify({ pages }), { status: 200, headers: { 'content-type': 'application/json' } })

describe('WikipediaResearchProvider', () => {
  it('splits an article into sentence-level facts, each carrying the page URL', async () => {
    const fetchImpl = vi.fn(async () =>
      extractResponse(
        'Venus',
        'Venus is the second planet from the Sun. It rotates in the opposite direction to most planets. Its day is longer than its year.',
      ),
    ) as unknown as typeof fetch

    const facts = await new WikipediaResearchProvider({ fetchImpl }).lookup('Venus')

    expect(facts).toHaveLength(3)
    expect(facts[0]!.text).toBe('Venus is the second planet from the Sun.')
    expect(facts.every((f) => f.sourceUrl === 'https://en.wikipedia.org/wiki/Venus')).toBe(true)
  })

  it('gathers well beyond a lead summary worth of facts from a full multi-section article', async () => {
    // Reproduces the real defect: the old REST summary endpoint returned only the lead extract,
    // and five genuinely relevant entities produced just nine usable facts total between them.
    // A full article's body sections must contribute facts too, not just its opening paragraph.
    const extract = [
      'Example Mission is a spacecraft that studies the outer heliosphere.',
      'It launched from Cape Canaveral on a Falcon 9 rocket.',
      '',
      '== History ==',
      'The mission was proposed in 2015 after earlier concepts were shelved.',
      'Development began in 2018 under budget pressure from a competing program.',
      'The spacecraft passed its critical design review in 2020.',
      '',
      '== Instruments ==',
      'The primary instrument is a wide-field imager built at a national laboratory.',
      'A secondary magnetometer measures the ambient magnetic field continuously.',
      'Both instruments share a single data-processing unit to save mass.',
      '',
      '== Science results ==',
      'Early data revealed structure in the solar wind not seen by prior missions.',
      'Researchers used the imager to track a coronal mass ejection for several days.',
    ].join('\n')
    const fetchImpl = vi.fn(async () => extractResponse('Example Mission', extract)) as unknown as typeof fetch

    const facts = await new WikipediaResearchProvider({ fetchImpl }).lookup('Example Mission', { maxFacts: 50 })

    // Nine real sentences of body content plus the two lead sentences = 11; the old lead-only
    // endpoint would have surfaced only the first two.
    expect(facts.length).toBeGreaterThan(8)
    expect(facts[0]!.text).toBe('Example Mission is a spacecraft that studies the outer heliosphere.')
    expect(facts.some((f) => f.text.includes('coronal mass ejection'))).toBe(true)
  })

  it('respects maxFacts', async () => {
    const fetchImpl = vi.fn(async () =>
      extractResponse(
        'Venus',
        'Alpha appears first in the list. Beta comes right after alpha. Gamma follows beta in turn. Delta is the fourth entry here. Epsilon closes the list at last.',
      ),
    ) as unknown as typeof fetch

    const facts = await new WikipediaResearchProvider({ fetchImpl }).lookup('Venus', { maxFacts: 2 })

    expect(facts).toHaveLength(2)
  })

  it('drops section headings entirely rather than treating them as facts', async () => {
    // "== History ==" names a section; it asserts nothing on its own, so it must never become a
    // fact even though heading text is often long enough to pass the length filter alone.
    const extract = [
      'The subject has an extensively documented history spanning several decades.',
      '== History and background information ==',
      'Development started after an earlier proposal was rejected for budget reasons.',
    ].join('\n')
    const fetchImpl = vi.fn(async () => extractResponse('Subject', extract)) as unknown as typeof fetch

    const facts = await new WikipediaResearchProvider({ fetchImpl }).lookup('Subject')

    expect(facts.some((f) => f.text.includes('=='))).toBe(false)
    expect(facts.some((f) => f.text === 'History and background information')).toBe(false)
  })

  it('truncates the article at a boilerplate tail section instead of mining it for facts', async () => {
    const extract = [
      'The subject is a well-documented spacecraft launched in the last decade.',
      '== See also ==',
      'A list of related missions that share overlapping scientific objectives with this one.',
      '== References ==',
      'A long citation entry naming a journal article that supports a claim made above.',
    ].join('\n')
    const fetchImpl = vi.fn(async () => extractResponse('Subject', extract)) as unknown as typeof fetch

    const facts = await new WikipediaResearchProvider({ fetchImpl }).lookup('Subject', { maxFacts: 20 })

    expect(facts).toHaveLength(1)
    expect(facts[0]!.text).toBe('The subject is a well-documented spacecraft launched in the last decade.')
    expect(facts.some((f) => f.text.includes('related missions'))).toBe(false)
    expect(facts.some((f) => f.text.includes('citation entry'))).toBe(false)
  })

  it('returns an empty array when the article does not exist (200 OK with a missing page)', async () => {
    const fetchImpl = vi.fn(async () => missingResponse('Nonexistent')) as unknown as typeof fetch

    await expect(new WikipediaResearchProvider({ fetchImpl }).lookup('Nonexistent')).resolves.toEqual([])
  })

  it('returns an empty array when the endpoint itself fails, rather than throwing', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch

    await expect(new WikipediaResearchProvider({ fetchImpl }).lookup('Anything')).resolves.toEqual([])
  })

  it('discards fragments too short to be a usable fact', async () => {
    const fetchImpl = vi.fn(async () =>
      extractResponse('Venus', 'Venus is the second planet from the Sun. Yes. It rotates backwards compared with most planets.'),
    ) as unknown as typeof fetch

    const facts = await new WikipediaResearchProvider({ fetchImpl }).lookup('Venus')

    expect(facts.map((f) => f.text)).not.toContain('Yes.')
  })

  it('retries without a trailing parenthetical when the exact title is missing', async () => {
    // Reproduces a real qwen3:8b research entity: "Lunar Reconnaissance Orbiter (LRO)" has no
    // article, but the actual Wikipedia page — "Lunar Reconnaissance Orbiter" — exists.
    const requested: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(decodeURIComponent(url))
      if (url.includes('LRO')) return missingResponse('Lunar Reconnaissance Orbiter (LRO)')
      return extractResponse(
        'Lunar Reconnaissance Orbiter',
        'The Lunar Reconnaissance Orbiter is a NASA robotic spacecraft.',
      )
    }) as unknown as typeof fetch

    const facts = await new WikipediaResearchProvider({ fetchImpl }).lookup(
      'Lunar Reconnaissance Orbiter (LRO)',
    )

    expect(facts).toHaveLength(1)
    expect(requested).toHaveLength(2)
    expect(requested[1]).toContain('Lunar Reconnaissance Orbiter')
  })

  it('does not retry when the exact title already succeeded', async () => {
    const fetchImpl = vi.fn(async () =>
      extractResponse('Venus', 'Venus is the second planet from the Sun.'),
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
    // Reproduces a real qwen3:8b research entity: "Rocket Propulsion Systems" has no article
    // (no parenthetical to strip either), but the real page — "Spacecraft propulsion" — exists
    // and is exactly what Wikipedia's own search resolves it to.
    const requested: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(decodeURIComponent(url))
      if (url.includes('/search/page')) return searchResponse([{ title: 'Spacecraft propulsion' }])
      if (url.includes('Spacecraft%20propulsion') || url.includes('Spacecraft+propulsion')) {
        return extractResponse('Spacecraft propulsion', 'Spacecraft propulsion is any method used to accelerate spacecraft.')
      }
      return missingResponse('Rocket Propulsion Systems')
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
      if (url.includes('/search/page')) return searchResponse([{ title: 'Spacecraft propulsion' }])
      if (url.includes('Spacecraft%20propulsion') || url.includes('Spacecraft+propulsion')) {
        return extractResponse('Spacecraft propulsion', 'Spacecraft propulsion is any method used to accelerate spacecraft.')
      }
      return missingResponse('Rocket Propulsion Systems')
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
      extractResponse('Venus', 'Venus is the second planet from the Sun.'),
    ) as unknown as typeof fetch
    const logged: string[] = []

    await new WikipediaResearchProvider({ fetchImpl, log: (m) => logged.push(m) }).lookup('Venus')

    expect(logged.some((m) => m.includes('resolved'))).toBe(false)
  })

  it('returns empty when the search endpoint itself finds nothing', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/search/page')) return searchResponse([])
      return missingResponse('Utterly Fabricated Thing')
    }) as unknown as typeof fetch

    const facts = await new WikipediaResearchProvider({ fetchImpl }).lookup('Utterly Fabricated Thing')

    expect(facts).toEqual([])
  })

  it('does not fall through to search once the exact title already succeeded', async () => {
    const fetchImpl = vi.fn(async () =>
      extractResponse('Venus', 'Venus is the second planet from the Sun.'),
    ) as unknown as typeof fetch

    await new WikipediaResearchProvider({ fetchImpl }).lookup('Venus')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rejects a search result that is not actually about the query, real Wikipedia data', async () => {
    // Reproduces the real failure: Wikipedia's search API, asked for the topic's raw
    // news-headline title, returned exactly one result — "Brown dwarf", a real, well-
    // documented, and utterly unrelated page — which the old limit=1/accept-anything code
    // took at face value. The query and result below are the real ones captured from that run.
    const requested: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(decodeURIComponent(url))
      if (url.includes('/search/page')) {
        return searchResponse([{ title: 'Brown dwarf', description: 'Substellar object' }])
      }
      return missingResponse('unused')
    }) as unknown as typeof fetch
    const logged: string[] = []

    const facts = await new WikipediaResearchProvider({ fetchImpl, log: (m) => logged.push(m) }).lookup(
      "NASA's PUNCH Sharpens Solar Storm Forecasting in First Test",
    )

    expect(facts).toEqual([])
    // The extract endpoint for "Brown dwarf" must never even be requested — an unrelated
    // search hit must not be silently promoted into a fetch.
    expect(requested.some((u) => u.includes('Brown'))).toBe(false)
    const rejectionLog = logged.find((m) => m.includes('rejected'))
    expect(rejectionLog).toContain("NASA's PUNCH Sharpens Solar Storm Forecasting in First Test")
    expect(rejectionLog).toContain('Brown dwarf')
  })

  it('accepts a genuine match even with zero shared title words, real Wikipedia data', async () => {
    // Reproduces the real, correct resolution: the model's entity name "NASA's PUNCH Mission"
    // shares no words at all with the real page title "Polarimeter to Unify the Corona and
    // Heliosphere" (PUNCH is an acronym for that name) — only "NASA" in the search result's
    // description ties them together. Wikipedia ranks it first; that ranking must be trusted
    // rather than overridden by a naive title-only overlap score.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/search/page')) {
        return searchResponse([
          {
            title: 'Polarimeter to Unify the Corona and Heliosphere',
            description: 'NASA satellite of the Explorer program',
          },
          { title: 'Nicholeen Viall', description: 'American solar physicist' },
          {
            title: 'Magnetospheric Multiscale Mission',
            description: "Four NASA robots studying Earth's magnetosphere (2015-present)",
          },
          { title: 'TRACERS', description: 'NASA heliophysics spacecraft' },
          { title: 'List of Falcon 9 and Falcon Heavy launches', description: '' },
        ])
      }
      if (url.includes('Polarimeter')) {
        return extractResponse(
          'Polarimeter to Unify the Corona and Heliosphere',
          'PUNCH is a NASA heliophysics mission to study the solar corona.',
        )
      }
      return missingResponse('unused')
    }) as unknown as typeof fetch

    const facts = await new WikipediaResearchProvider({ fetchImpl }).lookup("NASA's PUNCH Mission")

    expect(facts).toHaveLength(1)
    expect(facts[0]!.sourceUrl).toBe(
      'https://en.wikipedia.org/wiki/Polarimeter_to_Unify_the_Corona_and_Heliosphere',
    )
  })

  it('skips an irrelevant top search result to accept a genuinely related lower-ranked one', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/search/page')) {
        return searchResponse([
          { title: 'HENON', description: 'European spacecraft' },
          { title: 'Solar cycle 25', description: 'Solar activity from 2019 to about 2030' },
        ])
      }
      if (url.includes('cycle')) {
        return extractResponse('Solar cycle 25', 'Solar cycle 25 is the current solar cycle.')
      }
      return missingResponse('unused')
    }) as unknown as typeof fetch

    const facts = await new WikipediaResearchProvider({ fetchImpl }).lookup('Solar Storm Forecasting')

    expect(facts).toHaveLength(1)
    expect(facts[0]!.sourceUrl).toBe('https://en.wikipedia.org/wiki/Solar_cycle_25')
  })

  it('constructs the source URL from the article\'s own (post-redirect) title', async () => {
    // The action API never returns anything like the old REST endpoint's content_urls, and the
    // resolved title can differ from what was requested (e.g. "USA" -> "United States" via
    // Wikipedia's own redirect), so the URL must always be built from the title the page itself
    // reports, not the query string.
    const fetchImpl = vi.fn(async () =>
      extractResponse('United States', 'The United States is a country in North America.'),
    ) as unknown as typeof fetch

    const facts = await new WikipediaResearchProvider({ fetchImpl }).lookup('USA')

    expect(facts[0]!.sourceUrl).toBe('https://en.wikipedia.org/wiki/United_States')
  })
})
