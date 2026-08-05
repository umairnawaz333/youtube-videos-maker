import { describe, expect, it } from 'vitest'
import { SOURCE_FETCHERS } from '@yt/providers'

/** A minimal fetch stand-in that always returns the given XML body as text. */
const fetchReturningXml = (xml: string): typeof fetch =>
  (async () =>
    ({
      ok: true,
      status: 200,
      text: async () => xml,
    }) as unknown as Response) as unknown as typeof fetch

describe('titlesFromFeed (via the arxiv fetcher)', () => {
  it('decodes a named entity', async () => {
    const xml = `<feed><title>Feed title</title><entry><title>Tom &amp; Jerry</title></entry></feed>`

    const got = await SOURCE_FETCHERS.arxiv(fetchReturningXml(xml))

    expect(got.map((c) => c.title)).toEqual(['Tom & Jerry'])
  })

  it('decodes a numeric entity', async () => {
    const xml = `<feed><title>Feed title</title><entry><title>&#39;Hello&#39; there</title></entry></feed>`

    const got = await SOURCE_FETCHERS.arxiv(fetchReturningXml(xml))

    expect(got.map((c) => c.title)).toEqual(["'Hello' there"])
  })

  it('decodes a hex numeric entity', async () => {
    const xml = `<feed><title>Feed title</title><entry><title>caf&#x65;s</title></entry></feed>`

    const got = await SOURCE_FETCHERS.arxiv(fetchReturningXml(xml))

    expect(got.map((c) => c.title)).toEqual(['cafes'])
  })

  it('decodes entities inside a CDATA section', async () => {
    const xml = `<feed><title>Feed title</title><entry><title><![CDATA[Bob&#39;s big idea]]></title></entry></feed>`

    const got = await SOURCE_FETCHERS.arxiv(fetchReturningXml(xml))

    expect(got.map((c) => c.title)).toEqual(["Bob's big idea"])
  })

  it('does not double-decode an already-escaped ampersand entity', async () => {
    // "&amp;#39;" is a literal "&#39;" that was itself entity-escaped. Decoding must produce
    // "&#39;", not go on to decode that into an apostrophe.
    const xml = `<feed><title>Feed title</title><entry><title>literal &amp;#39; sequence</title></entry></feed>`

    const got = await SOURCE_FETCHERS.arxiv(fetchReturningXml(xml))

    expect(got.map((c) => c.title)).toEqual(['literal &#39; sequence'])
  })
})

describe('the nasa fetcher', () => {
  it('drops the feed\'s own title and returns each entry tagged with source "nasa"', async () => {
    const xml =
      '<rss><channel><title>NASA</title>' +
      '<item><title><![CDATA[NASA Will Attempt to Observe Rocket Part’s Lunar Impact]]></title></item>' +
      '<item><title><![CDATA[APOD: 2026 August 4 – Curious Cometary Knots]]></title></item>' +
      '</channel></rss>'

    const got = await SOURCE_FETCHERS.nasa(fetchReturningXml(xml))

    expect(got).toEqual([
      {
        key: expect.stringContaining('nasa-will-attempt-to-observe-rocket-part'),
        title: 'NASA Will Attempt to Observe Rocket Part’s Lunar Impact',
        source: 'nasa',
        url: null,
      },
      {
        key: expect.stringContaining('apod-2026-august-4'),
        title: 'APOD: 2026 August 4 – Curious Cometary Knots',
        source: 'nasa',
        url: null,
      },
    ])
  })
})
