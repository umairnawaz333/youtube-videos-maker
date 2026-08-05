import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_TAGS_CHARS, MAX_TITLE_CHARS, ScriptSchema, SECTION_KINDS, SeoSchema, TopicSchema, type RunContext } from '@yt/core'
import { buildSeoMetadataPrompt, buildSeoTitlesPrompt, createSeoStage } from '@yt/pipeline'
import { makeStageContext, type StageHarness } from '../../../../test/fixtures/stage-context'

let h: StageHarness

const titleBatch = (count: number, startIndex: number, opts: { overlong?: boolean } = {}) =>
  Array.from({ length: count }, (_, i) => ({
    title: opts.overlong && startIndex + i === 0 ? 'x'.repeat(120) : `Candidate title number ${startIndex + i}`,
    scores: { curiosity: (startIndex + i) % 10, searchIntent: 5, simplicity: 5, ctr: 5 },
  }))

const defaultMetadata = { description: 'A description.', tags: ['a'], hashtags: ['#a'] }

/**
 * Dispatches by schema name, the way the real OllamaLlmProvider call site does not need to but
 * a fake standing in for four title-batch calls plus one metadata call does. `titlesPerBatch`
 * lets a test control how many raw titles come back per batch call (independent of how many
 * the stage actually requested), which is what exercises the "too few survive" and "one extra
 * overlong title" cases below.
 */
const mockLlm = (
  opts: { titlesPerBatch?: (batchIndex: number) => { count: number; overlong?: boolean }; metadata?: typeof defaultMetadata } = {},
): RunContext['providers']['llm']['json'] => {
  let batchIndex = 0
  let startIndex = 0
  return (async (_prompt: string, schemaName: string) => {
    if (schemaName === 'SeoTitlesBatch') {
      const { count, overlong } = opts.titlesPerBatch?.(batchIndex) ?? { count: 5 }
      const batch = titleBatch(count, startIndex, { overlong })
      startIndex += count
      batchIndex += 1
      return { titles: batch }
    }
    if (schemaName === 'SeoMetadata') {
      return opts.metadata ?? defaultMetadata
    }
    throw new Error(`unexpected schema in test mock: ${schemaName}`)
  }) as RunContext['providers']['llm']['json']
}

beforeEach(async () => {
  h = await makeStageContext()
  await h.ctx.artifacts.write('topic', TopicSchema, {
    key: 'venus', title: 'Why Venus rotates backwards', source: 'wikipedia-top',
    url: 'https://en.wikipedia.org/wiki/Venus',
    angle: 'Follow the radar measurement.',
    scores: { curiosity: 9, explainability: 8, visualPotential: 7, evergreen: 9 }, total: 33,
  })
  await h.ctx.artifacts.write('script', ScriptSchema, {
    topicTitle: 'Why Venus rotates backwards',
    sections: SECTION_KINDS.map((kind) => ({ kind, beats: [{ id: kind, text: `Narration for ${kind}.`, targetSeconds: 20 }] })),
  })
})
afterEach(async () => {
  await h.cleanup()
})

describe('buildSeoTitlesPrompt', () => {
  it('states the requested count and the four scoring dimensions', () => {
    const prompt = buildSeoTitlesPrompt({ topicTitle: 'T', angle: 'A', count: 5 })
    expect(prompt).toContain('5')
    for (const dim of ['curiosity', 'searchIntent', 'simplicity', 'ctr']) expect(prompt).toContain(dim)
  })

  it('states the character limit', () => {
    const prompt = buildSeoTitlesPrompt({ topicTitle: 'T', angle: 'A', count: 5 })
    expect(prompt).toContain(String(MAX_TITLE_CHARS))
  })

  it('lists titles to avoid when some were already generated', () => {
    const prompt = buildSeoTitlesPrompt({ topicTitle: 'T', angle: 'A', count: 5, avoid: ['First title', 'Second title'] })
    expect(prompt).toContain('First title')
    expect(prompt).toContain('Second title')
  })

  it('says nothing about avoiding titles on the first batch', () => {
    const prompt = buildSeoTitlesPrompt({ topicTitle: 'T', angle: 'A', count: 5, avoid: [] })
    expect(prompt).not.toContain('Do not repeat')
  })
})

describe('buildSeoMetadataPrompt', () => {
  it('includes the niche SEO rules', () => {
    const prompt = buildSeoMetadataPrompt({ topicTitle: 'T', angle: 'A', beats: ['b'], seoRules: 'Lead with the object.' })
    expect(prompt).toContain('Lead with the object.')
  })
})

describe('createSeoStage', () => {
  it('requests titles in batches of five rather than all twenty at once', async () => {
    // The exact failure this guards against: a real qwen3:8b run asked for all 20 titles in one
    // call reliably came back with a hallucinated refusal instead of scoring anything.
    const seenCounts: number[] = []
    h.providers.llm.json = (async (prompt: string, schemaName: string, parse: (raw: unknown) => unknown) => {
      if (schemaName === 'SeoTitlesBatch') {
        seenCounts.push(prompt.length) // presence check only; real assertion is call count below
        return parse({ titles: titleBatch(5, seenCounts.length * 5 - 5) })
      }
      return parse(defaultMetadata)
    }) as RunContext['providers']['llm']['json']

    await createSeoStage().run(h.ctx)

    expect(seenCounts).toHaveLength(4) // 20 titles / 5 per batch
  })

  it('writes twenty titles and picks the highest scoring one', async () => {
    h.providers.llm.json = mockLlm()

    await expect(createSeoStage().run(h.ctx)).resolves.toEqual({ status: 'done' })

    const seo = await h.ctx.artifacts.read('seo', SeoSchema)
    expect(seo.titles).toHaveLength(20)
    const best = [...seo.titles].sort((a, b) => b.total - a.total)[0]!
    expect(seo.chosenTitle).toBe(best.title)
  })

  it('computes total from the four scores rather than requiring the model to sum them itself', async () => {
    h.providers.llm.json = mockLlm()

    await createSeoStage().run(h.ctx)

    const seo = await h.ctx.artifacts.read('seo', SeoSchema)
    // Index 9 lands in the second batch (indices 5-9) and scores curiosity=9.
    const withHighestDimension = seo.titles.find((t) => t.title === 'Candidate title number 9')!
    expect(withHighestDimension.total).toBe(9 + 5 + 5 + 5)
  })

  it('discards titles over the character limit and still writes twenty', async () => {
    // First batch returns 6 raw titles (one overlong) instead of 5, so 21 raw titles survive to
    // the filter — exactly enough left after discarding the overlong one.
    h.providers.llm.json = mockLlm({
      titlesPerBatch: (i) => (i === 0 ? { count: 6, overlong: true } : { count: 5 }),
    })

    await createSeoStage().run(h.ctx)

    const seo = await h.ctx.artifacts.read('seo', SeoSchema)
    expect(seo.titles).toHaveLength(20)
    expect(seo.titles.every((t) => t.title.length <= MAX_TITLE_CHARS)).toBe(true)
  })

  it('trims tags until the total is within the limit', async () => {
    h.providers.llm.json = mockLlm({
      metadata: { description: 'A description.', tags: Array.from({ length: 60 }, (_, i) => `tag-number-${i}-padded-out`), hashtags: ['#a'] },
    })

    await createSeoStage().run(h.ctx)

    const seo = await h.ctx.artifacts.read('seo', SeoSchema)
    expect(seo.tags.join(',').length).toBeLessThanOrEqual(MAX_TAGS_CHARS)
    expect(seo.tags.length).toBeGreaterThan(0)
  })

  it('truncates an over-long description rather than failing the run', async () => {
    h.providers.llm.json = mockLlm({
      metadata: { description: 'x'.repeat(6000), tags: ['a'], hashtags: ['#a'] },
    })

    await createSeoStage().run(h.ctx)

    const seo = await h.ctx.artifacts.read('seo', SeoSchema)
    expect(seo.description.length).toBeLessThanOrEqual(5000)
  })

  it('throws when the same titles come back on every batch, rather than counting duplicates as usable', async () => {
    // Reproduces the exact failure: the four batch calls are independent, so a near-greedy
    // model can return its five best titles again on every batch. 4 batches x 5 identical
    // titles = 20 raw entries but only 5 DISTINCT ones — nowhere near enough.
    h.providers.llm.json = (async (_prompt: string, schemaName: string) => {
      if (schemaName === 'SeoTitlesBatch') return { titles: titleBatch(5, 0) } // same 5 every time
      return defaultMetadata
    }) as RunContext['providers']['llm']['json']

    await expect(createSeoStage().run(h.ctx)).rejects.toThrow(/5 distinct.*need 20/is)
    await expect(h.ctx.artifacts.exists('seo')).resolves.toBe(false)
  })

  it('is not fooled by a title repeated with different casing or surrounding whitespace', async () => {
    h.providers.llm.json = (async (_prompt: string, schemaName: string) => {
      if (schemaName === 'SeoTitlesBatch') {
        return {
          titles: [
            { title: 'A Title About Venus', scores: { curiosity: 5, searchIntent: 5, simplicity: 5, ctr: 5 } },
            { title: '  a title about venus  ', scores: { curiosity: 5, searchIntent: 5, simplicity: 5, ctr: 5 } },
            { title: 'A TITLE ABOUT VENUS', scores: { curiosity: 5, searchIntent: 5, simplicity: 5, ctr: 5 } },
          ],
        }
      }
      return defaultMetadata
    }) as RunContext['providers']['llm']['json']

    await expect(createSeoStage().run(h.ctx)).rejects.toThrow(/1 distinct/)
  })

  it('passes previously generated titles as the avoid list on later batch calls', async () => {
    const avoidLists: (string[] | undefined)[] = []
    h.providers.llm.json = (async (prompt: string, schemaName: string) => {
      if (schemaName === 'SeoTitlesBatch') {
        // Extract via the mock's own knowledge of what was requested is fragile; instead assert
        // through the prompt text, the same surface the real provider call site uses.
        avoidLists.push(prompt.includes('Do not repeat') ? ['present'] : undefined)
        const startIndex = avoidLists.length * 5 - 5
        return { titles: titleBatch(5, startIndex) }
      }
      return defaultMetadata
    }) as RunContext['providers']['llm']['json']

    await createSeoStage().run(h.ctx)

    expect(avoidLists[0]).toBeUndefined() // first batch: nothing generated yet
    expect(avoidLists[1]).toEqual(['present']) // later batches: avoid list is present
    expect(avoidLists[2]).toEqual(['present'])
    expect(avoidLists[3]).toEqual(['present'])
  })

  it('throws rather than halting when fewer than twenty usable titles survive', async () => {
    // Halting here would throw away a finished, fact-checked script at the last stage over the
    // one thing that is cheap to re-ask for. Throwing lets the retry budget apply instead.
    h.providers.llm.json = mockLlm({ titlesPerBatch: () => ({ count: 1 }) }) // 4 batches x 1 = 4 total

    await expect(createSeoStage().run(h.ctx)).rejects.toThrow(/need 20/)
    await expect(h.ctx.artifacts.exists('seo')).resolves.toBe(false)
  })

  it('passes the configured temperature through to both title and metadata calls', async () => {
    h.ctx.config.llm.temperature = 0.33
    const seenOpts: unknown[] = []
    h.providers.llm.json = (async (
      _prompt: string,
      schemaName: string,
      parse: (raw: unknown) => unknown,
      opts: unknown,
    ) => {
      seenOpts.push(opts)
      if (schemaName === 'SeoTitlesBatch') return parse({ titles: titleBatch(5, seenOpts.length * 5 - 5) })
      return parse(defaultMetadata)
    }) as RunContext['providers']['llm']['json']

    await createSeoStage().run(h.ctx)

    expect(seenOpts.length).toBeGreaterThan(0)
    expect(
      seenOpts.every(
        (o) => JSON.stringify(o) === JSON.stringify({ temperature: 0.33, numCtx: h.ctx.config.llm.numCtx }),
      ),
    ).toBe(true)
  })
})
