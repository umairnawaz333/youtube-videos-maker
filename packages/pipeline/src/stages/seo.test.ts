import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_TAGS_CHARS, MAX_TITLE_CHARS, ScriptSchema, SECTION_KINDS, SeoSchema, TopicSchema, type RunContext } from '@yt/core'
import { buildSeoPrompt, createSeoStage } from '@yt/pipeline'
import { makeStageContext, type StageHarness } from '../../../../test/fixtures/stage-context'

let h: StageHarness

const titles = (count: number, opts: { overlong?: boolean } = {}) =>
  Array.from({ length: count }, (_, i) => ({
    title: opts.overlong && i === 0 ? 'x'.repeat(120) : `Candidate title number ${i}`,
    scores: { curiosity: i % 10, searchIntent: 5, simplicity: 5, ctr: 5 },
    total: (i % 10) + 15,
  }))

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

describe('buildSeoPrompt', () => {
  it('includes the niche SEO rules and the four scoring dimensions', () => {
    const prompt = buildSeoPrompt({ topicTitle: 'T', angle: 'A', beats: ['b'], seoRules: 'Lead with the object.' })
    expect(prompt).toContain('Lead with the object.')
    for (const dim of ['curiosity', 'searchIntent', 'simplicity', 'ctr']) expect(prompt).toContain(dim)
  })

  it('states the twenty-title requirement and the character limits', () => {
    const prompt = buildSeoPrompt({ topicTitle: 'T', angle: 'A', beats: ['b'], seoRules: 'r' })
    expect(prompt).toContain('20')
    expect(prompt).toContain(String(MAX_TITLE_CHARS))
  })
})

describe('createSeoStage', () => {
  it('writes twenty titles and picks the highest scoring one', async () => {
    h.providers.llm.json = (async () => ({
      titles: titles(20), description: 'A description.', tags: ['venus', 'space'], hashtags: ['#space'],
    })) as RunContext['providers']['llm']['json']

    await expect(createSeoStage().run(h.ctx)).resolves.toEqual({ status: 'done' })

    const seo = await h.ctx.artifacts.read('seo', SeoSchema)
    expect(seo.titles).toHaveLength(20)
    const best = [...seo.titles].sort((a, b) => b.total - a.total)[0]!
    expect(seo.chosenTitle).toBe(best.title)
  })

  it('overrides the model when it names a title that is not the best scoring one', async () => {
    h.providers.llm.json = (async () => ({
      titles: titles(20), chosenTitle: 'Candidate title number 0',
      description: 'A description.', tags: ['a'], hashtags: ['#a'],
    })) as RunContext['providers']['llm']['json']

    await createSeoStage().run(h.ctx)

    const seo = await h.ctx.artifacts.read('seo', SeoSchema)
    expect(seo.chosenTitle).not.toBe('Candidate title number 0')
  })

  it('discards titles over the character limit and still writes twenty', async () => {
    h.providers.llm.json = (async () => ({
      titles: titles(21, { overlong: true }), description: 'A description.', tags: ['a'], hashtags: ['#a'],
    })) as RunContext['providers']['llm']['json']

    await createSeoStage().run(h.ctx)

    const seo = await h.ctx.artifacts.read('seo', SeoSchema)
    expect(seo.titles).toHaveLength(20)
    expect(seo.titles.every((t) => t.title.length <= MAX_TITLE_CHARS)).toBe(true)
  })

  it('trims tags until the total is within the limit', async () => {
    h.providers.llm.json = (async () => ({
      titles: titles(20), description: 'A description.',
      tags: Array.from({ length: 60 }, (_, i) => `tag-number-${i}-padded-out`), hashtags: ['#a'],
    })) as RunContext['providers']['llm']['json']

    await createSeoStage().run(h.ctx)

    const seo = await h.ctx.artifacts.read('seo', SeoSchema)
    expect(seo.tags.join(',').length).toBeLessThanOrEqual(MAX_TAGS_CHARS)
    expect(seo.tags.length).toBeGreaterThan(0)
  })

  it('truncates an over-long description rather than failing the run', async () => {
    h.providers.llm.json = (async () => ({
      titles: titles(20), description: 'x'.repeat(6000), tags: ['a'], hashtags: ['#a'],
    })) as RunContext['providers']['llm']['json']

    await createSeoStage().run(h.ctx)

    const seo = await h.ctx.artifacts.read('seo', SeoSchema)
    expect(seo.description.length).toBeLessThanOrEqual(5000)
  })

  it('throws rather than halting when fewer than twenty usable titles survive', async () => {
    // Halting here would throw away a finished, fact-checked script at the last stage over the
    // one thing that is cheap to re-ask for. Throwing lets the retry budget apply instead.
    h.providers.llm.json = (async () => ({
      titles: titles(3), description: 'A description.', tags: ['a'], hashtags: ['#a'],
    })) as RunContext['providers']['llm']['json']

    await expect(createSeoStage().run(h.ctx)).rejects.toThrow(/need 20/)
    await expect(h.ctx.artifacts.exists('seo')).resolves.toBe(false)
  })
})
