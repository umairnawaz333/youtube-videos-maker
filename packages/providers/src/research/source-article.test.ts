import { describe, expect, it, vi } from 'vitest'
import { fetchSourceArticleFacts, looksLikeArticleProse } from './source-article'

const htmlResponse = (html: string, status = 200): Response =>
  new Response(html, { status, headers: { 'content-type': 'text/html' } })

describe('looksLikeArticleProse', () => {
  it('accepts real prose with a normal sentence-punctuation density', () => {
    const text =
      'NASA and SpaceX are tracking a spent rocket stage expected to strike the Moon this week. ' +
      'The impact is expected near a set of well mapped craters in the southern highlands. ' +
      'Scientists plan to use ground telescopes to observe the resulting debris plume.'
    expect(looksLikeArticleProse(text)).toBe(true)
  })

  it('rejects a short fragment below the minimum length', () => {
    expect(looksLikeArticleProse('Too short.')).toBe(false)
  })

  it('rejects a long run of navigation-style words with no sentence punctuation', () => {
    const nav = Array.from({ length: 60 }, (_, i) => `NavItem${i}`).join(' ')
    expect(looksLikeArticleProse(nav)).toBe(false)
  })
})

describe('fetchSourceArticleFacts', () => {
  it('extracts sentence-level facts from inside <article>, ignoring nav/script/footer noise', async () => {
    const html =
      '<html><head><script type="application/ld+json">{"description":"A misleading sentence from JSON-LD metadata that never appears in the body."}</script></head>' +
      '<body><nav>Home About Contact Search Missions Science News Videos Images</nav>' +
      '<article><p>NASA and SpaceX are tracking a spent rocket stage expected to strike the Moon this week.</p>' +
      '<p>The impact is expected near a set of well mapped craters in the southern highlands.</p>' +
      '<p>Scientists plan to use ground telescopes to observe the resulting debris plume in detail.</p></article>' +
      '<footer>Copyright NASA. All rights reserved. Privacy policy. Contact us.</footer></body></html>'
    const fetchImpl = vi.fn(async () => htmlResponse(html)) as unknown as typeof fetch

    const facts = await fetchSourceArticleFacts('https://example.test/article', { fetchImpl })

    expect(facts.length).toBeGreaterThanOrEqual(2)
    expect(facts.every((f) => f.sourceUrl === 'https://example.test/article')).toBe(true)
    expect(facts.some((f) => f.text.includes('misleading sentence'))).toBe(false)
    expect(facts.some((f) => f.text.includes('Copyright'))).toBe(false)
    expect(facts.some((f) => f.text.includes('spent rocket stage'))).toBe(true)
  })

  it('falls back to <main> when the page has no <article> tag', async () => {
    const html =
      '<html><body><nav>Home About Contact</nav>' +
      '<main><p>The mission launched successfully from the coastal pad early this morning.</p>' +
      '<p>Engineers confirmed telemetry looked nominal throughout the ascent phase of flight.</p>' +
      '<p>The upper stage separated cleanly and continued on its planned trajectory today.</p></main>' +
      '</body></html>'
    const fetchImpl = vi.fn(async () => htmlResponse(html)) as unknown as typeof fetch

    const facts = await fetchSourceArticleFacts('https://example.test/main-only', { fetchImpl })

    expect(facts.some((f) => f.text.includes('launched successfully'))).toBe(true)
  })

  it('decodes HTML entities the same way the RSS feed parser does', async () => {
    const html =
      '<article><p>The rocket part&#39;s trajectory intersected the Moon&#39;s orbit path exactly as predicted by engineers on the ground.</p>' +
      '<p>Mission controllers confirmed the tracking data matched their models closely throughout the approach.</p></article>'
    const fetchImpl = vi.fn(async () => htmlResponse(html)) as unknown as typeof fetch

    const facts = await fetchSourceArticleFacts('https://example.test/entities', { fetchImpl })

    expect(facts.length).toBeGreaterThan(0)
    expect(facts[0]?.text).toContain("rocket part's trajectory")
  })

  it('returns nothing and logs when the response is not ok', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse('', 404)) as unknown as typeof fetch
    const logged: string[] = []

    const facts = await fetchSourceArticleFacts('https://example.test/missing', {
      fetchImpl,
      log: (m) => logged.push(m),
    })

    expect(facts).toEqual([])
    expect(logged.some((m) => m.includes('404'))).toBe(true)
  })

  it('returns nothing and logs when the fetch itself throws, rather than propagating', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const logged: string[] = []

    const facts = await fetchSourceArticleFacts('https://example.test/broken', {
      fetchImpl,
      log: (m) => logged.push(m),
    })

    expect(facts).toEqual([])
    expect(logged.some((m) => m.includes('network down'))).toBe(true)
  })

  it('takes nothing from a page that is mostly navigation boilerplate rather than poisoning the corpus', async () => {
    // Reproduces the exact failure mode an earlier fix in this project had to undo: content
    // that is merely long enough being mistaken for a fact just because nothing else filtered it.
    const nav = Array.from({ length: 80 }, (_, i) => `MenuLink${i}`).join(' ')
    const html = `<html><body><nav>${nav}</nav></body></html>`
    const fetchImpl = vi.fn(async () => htmlResponse(html)) as unknown as typeof fetch
    const logged: string[] = []

    const facts = await fetchSourceArticleFacts('https://example.test/nav-only', {
      fetchImpl,
      log: (m) => logged.push(m),
    })

    expect(facts).toEqual([])
    expect(logged.some((m) => m.includes('did not look like real article prose'))).toBe(true)
  })

  it('respects maxFacts', async () => {
    const html =
      '<article><p>Alpha sentence is definitely long enough to clear the minimum length threshold here.</p>' +
      '<p>Beta sentence also comfortably clears the same minimum length threshold applied here.</p>' +
      '<p>Gamma sentence follows the same pattern and clears the length threshold as well.</p></article>'
    const fetchImpl = vi.fn(async () => htmlResponse(html)) as unknown as typeof fetch

    const facts = await fetchSourceArticleFacts('https://example.test/many', { fetchImpl, maxFacts: 2 })

    expect(facts).toHaveLength(2)
  })
})
