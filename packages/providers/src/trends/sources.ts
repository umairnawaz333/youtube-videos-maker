import type { TopicCandidate, TrendSource } from '@yt/core'

/** Stable dedupe identity for a candidate. Case- and punctuation-insensitive. */
export const slugifyKey = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

export type SourceFetcher = (fetchImpl: typeof fetch) => Promise<TopicCandidate[]>

const USER_AGENT = 'ai-youtube-factory/0.1 (local, personal use)'

const getJson = async (fetchImpl: typeof fetch, url: string): Promise<unknown> => {
  const res = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' } })
  if (!res.ok) throw new Error(`${url} returned ${res.status}`)
  return res.json()
}

const getText = async (fetchImpl: typeof fetch, url: string): Promise<string> => {
  const res = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT } })
  if (!res.ok) throw new Error(`${url} returned ${res.status}`)
  return res.text()
}

/** Pull <title> contents out of an RSS/Atom feed without adding an XML parser. */
const titlesFromFeed = (xml: string): string[] =>
  [...xml.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi)]
    .map((m) => (m[1] ?? '').replace(/<!\[CDATA\[|\]\]>/g, '').trim())
    .filter((t) => t.length > 0)

/**
 * Two days back in UTC. Verified by hand against the live endpoint: yesterday's
 * pageview data is consistently not published yet, but the day before is.
 */
const recentPublishedDateParts = (): { y: string; m: string; d: string } => {
  const t = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  return {
    y: String(t.getUTCFullYear()),
    m: String(t.getUTCMonth() + 1).padStart(2, '0'),
    d: String(t.getUTCDate()).padStart(2, '0'),
  }
}

const wikipediaTop: SourceFetcher = async (fetchImpl) => {
  const { y, m, d } = recentPublishedDateParts()
  // The pageviews REST API lives on wikimedia.org, not en.wikipedia.org — the latter
  // 404s unconditionally (confirmed by hand against the live endpoint).
  const body = (await getJson(
    fetchImpl,
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${y}/${m}/${d}`,
  )) as { items?: { articles?: { article?: string }[] }[] }

  const articles = body.items?.[0]?.articles ?? []
  return articles
    .map((a) => a.article ?? '')
    // Portal pages, the front page and search are not video subjects.
    .filter((a) => a && !a.includes(':') && a !== 'Main_Page')
    .slice(0, 25)
    .map((a) => {
      const title = a.replace(/_/g, ' ')
      return {
        key: slugifyKey(title),
        title,
        source: 'wikipedia-top' as const,
        url: `https://en.wikipedia.org/wiki/${a}`,
      }
    })
}

const hackernews: SourceFetcher = async (fetchImpl) => {
  const body = (await getJson(fetchImpl, 'https://hn.algolia.com/api/v1/search?tags=front_page')) as {
    hits?: { title?: string; url?: string | null; objectID?: string }[]
  }
  return (body.hits ?? [])
    .filter((h) => h.title)
    .slice(0, 25)
    .map((h) => ({
      key: h.objectID ? `hn-${h.objectID}` : slugifyKey(h.title!),
      title: h.title!,
      source: 'hackernews' as const,
      url: h.url ?? null,
    }))
}

const arxiv: SourceFetcher = async (fetchImpl) => {
  const xml = await getText(
    fetchImpl,
    'http://export.arxiv.org/api/query?search_query=cat:cs.AI&sortBy=submittedDate&sortOrder=descending&max_results=20',
  )
  // The first <title> is the feed's own title, not an entry.
  return titlesFromFeed(xml)
    .slice(1)
    .map((title) => ({ key: slugifyKey(title), title, source: 'arxiv' as const, url: null }))
}

const reddit: SourceFetcher = async (fetchImpl) => {
  const body = (await getJson(
    fetchImpl,
    'https://www.reddit.com/r/todayilearned/top.json?t=week&limit=20',
  )) as { data?: { children?: { data?: { title?: string; permalink?: string; id?: string } }[] } }

  return (body.data?.children ?? [])
    .map((c) => c.data)
    .filter((d): d is { title: string; permalink?: string; id?: string } => Boolean(d?.title))
    .map((d) => ({
      key: d.id ? `reddit-${d.id}` : slugifyKey(d.title),
      // TIL posts are phrased as "TIL that ..."; strip the prefix so the title reads cleanly.
      title: d.title.replace(/^TIL\s+(that\s+)?/i, ''),
      source: 'reddit' as const,
      url: d.permalink ? `https://www.reddit.com${d.permalink}` : null,
    }))
}

const googleTrends: SourceFetcher = async (fetchImpl) => {
  // The old /trends/trendingsearches/daily/rss path 404s unconditionally now (confirmed
  // by hand); Google moved the feed to /trending/rss.
  const xml = await getText(fetchImpl, 'https://trends.google.com/trending/rss?geo=US')
  return titlesFromFeed(xml)
    .slice(1)
    .map((title) => ({ key: slugifyKey(title), title, source: 'google-trends' as const, url: null }))
}

export const SOURCE_FETCHERS: Record<TrendSource, SourceFetcher> = {
  'wikipedia-top': wikipediaTop,
  hackernews,
  arxiv,
  reddit,
  'google-trends': googleTrends,
}
