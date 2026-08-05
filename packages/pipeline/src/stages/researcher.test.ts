import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ResearchSchema, TopicSchema, type RunContext } from '@yt/core'
import { createResearcherStage, buildEntityPrompt } from '@yt/pipeline'
import { makeStageContext, type StageHarness } from '../../../../test/fixtures/stage-context'

let h: StageHarness

const writeTopic = async (harness: StageHarness, title = 'Why Venus rotates backwards') => {
  await harness.ctx.artifacts.write('topic', TopicSchema, {
    key: 'venus',
    title,
    source: 'wikipedia-top',
    url: 'https://en.wikipedia.org/wiki/Venus',
    angle: 'Follow the radar measurement that revealed the retrograde spin.',
    scores: { curiosity: 9, explainability: 8, visualPotential: 7, evergreen: 9 },
    total: 33,
  })
}

/** A sufficiently long fact so it survives the MIN_FACT_CHARS-equivalent trimming elsewhere. */
const fact = (label: string) => ({
  text: `A sufficiently long grounding fact about ${label} here.`,
  sourceUrl: 'https://en.wikipedia.org/wiki/X',
})

beforeEach(async () => {
  h = await makeStageContext()
  await writeTopic(h)
  // The default preset resolves to a 24-beat script (see script-writer's computeBeatPlan), and
  // the real corpus-floor default (1.5 facts/beat) would fail every one of the small,
  // hand-written fixtures below that aren't specifically testing the floor. Those tests use a
  // near-zero floor here and the floor tests further down restore a realistic value explicitly.
  h.ctx.config = { ...h.ctx.config, llm: { ...h.ctx.config.llm, researchMinFactsPerBeat: 0.01 } }
})
afterEach(async () => {
  await h.cleanup()
})

describe('buildEntityPrompt', () => {
  it('includes both the title and the angle, so entities serve the chosen take', () => {
    const prompt = buildEntityPrompt({ title: 'Why Venus rotates backwards', angle: 'Follow the radar measurement.' })
    expect(prompt).toContain('Why Venus rotates backwards')
    expect(prompt).toContain('Follow the radar measurement.')
  })

  it('asks for the encyclopedic subject separately from the headline-style working title', () => {
    const prompt = buildEntityPrompt({ title: 'Some Headline', angle: 'An angle.' })
    expect(prompt).toMatch(/subject/i)
    expect(prompt).toContain('"subject"')
  })
})

describe('createResearcherStage', () => {
  it('writes facts gathered for the subject and every entity the model named', async () => {
    h.providers.llm.json = (async () => ({
      subject: 'Venus',
      entities: ['Radar astronomy'],
    })) as RunContext['providers']['llm']['json']
    const asked: string[] = []
    h.providers.research.lookup = async (query) => {
      asked.push(query)
      return [fact(query)]
    }

    await expect(createResearcherStage().run(h.ctx)).resolves.toEqual({ status: 'done' })

    expect(asked).toEqual(['Venus', 'Radar astronomy'])
    const research = await h.ctx.artifacts.read('research', ResearchSchema)
    expect(research.topicTitle).toBe('Why Venus rotates backwards')
    expect(research.facts).toHaveLength(2)
  })

  it('caps how many entities are researched even when the model lists far more than asked', async () => {
    // Reproduces a real qwen3:8b response: told to list at most 4, it returned over a dozen.
    const manyEntities = Array.from({ length: 21 }, (_, i) => `Entity number ${i}`)
    h.providers.llm.json = (async () => ({
      subject: 'Venus',
      entities: manyEntities,
    })) as RunContext['providers']['llm']['json']
    const asked: string[] = []
    h.providers.research.lookup = async (query) => {
      asked.push(query)
      return [fact(query)]
    }

    await expect(createResearcherStage().run(h.ctx)).resolves.toEqual({ status: 'done' })

    // The subject plus at most 5 of the model's entities.
    expect(asked.length).toBeLessThanOrEqual(6)
    expect(asked[0]).toBe('Venus')
  })

  it('always researches the model-extracted subject, not the raw headline-style working title', async () => {
    // The working title is a news headline; looking it up directly is what resolved to
    // "Brown dwarf" in a real run. The model's own extracted subject is what must be guaranteed
    // to be looked up instead.
    await writeTopic(h, "NASA's PUNCH Sharpens Solar Storm Forecasting in First Test")
    h.providers.llm.json = (async () => ({
      subject: 'Polarimeter to Unify the Corona and Heliosphere',
      entities: ['Solar Orbiter'],
    })) as RunContext['providers']['llm']['json']
    const asked: string[] = []
    h.providers.research.lookup = async (query) => {
      asked.push(query)
      return [fact(query)]
    }

    await createResearcherStage().run(h.ctx)

    expect(asked).toContain('Polarimeter to Unify the Corona and Heliosphere')
    expect(asked).not.toContain("NASA's PUNCH Sharpens Solar Storm Forecasting in First Test")
  })

  it('does not research the subject twice when the model repeats it in its own entity list', async () => {
    h.providers.llm.json = (async () => ({
      subject: 'Venus',
      entities: ['Venus', 'Radar astronomy'],
    })) as RunContext['providers']['llm']['json']
    const asked: string[] = []
    h.providers.research.lookup = async (query) => {
      asked.push(query)
      return [fact(query)]
    }

    await createResearcherStage().run(h.ctx)

    expect(asked).toEqual(['Venus', 'Radar astronomy'])
  })

  it('deduplicates identical facts returned for different entities', async () => {
    h.providers.llm.json = (async () => ({
      subject: 'Venus',
      entities: ['Venus planet'],
    })) as RunContext['providers']['llm']['json']
    h.providers.research.lookup = async () => [
      { text: 'The very same grounding fact returned twice over.', sourceUrl: 'https://en.wikipedia.org/wiki/Venus' },
    ]

    await createResearcherStage().run(h.ctx)

    const research = await h.ctx.artifacts.read('research', ResearchSchema)
    expect(research.facts).toHaveLength(1)
  })

  it('halts when no entity produced a single fact, since the script would be ungrounded', async () => {
    h.providers.llm.json = (async () => ({ subject: 'Venus', entities: [] })) as RunContext['providers']['llm']['json']
    h.providers.research.lookup = async () => []

    const outcome = await createResearcherStage().run(h.ctx)

    expect(outcome).toMatchObject({ status: 'halted' })
    expect((outcome as { reason: string }).reason).toMatch(/no facts|ungrounded/i)
  })

  it('survives one entity lookup failing and keeps the facts from the others', async () => {
    h.providers.llm.json = (async () => ({
      subject: 'Good',
      entities: ['Bad'],
    })) as RunContext['providers']['llm']['json']
    h.providers.research.lookup = async (query) => {
      if (query === 'Bad') throw new Error('lookup exploded')
      return [fact(query)]
    }

    const outcome = await createResearcherStage().run(h.ctx)

    expect(outcome).toEqual({ status: 'done' })
    const research = await h.ctx.artifacts.read('research', ResearchSchema)
    expect(research.facts.some((f) => f.text.includes('Good'))).toBe(true)
  })

  describe('corpus-floor halt', () => {
    // The default long preset resolves to a 24-beat script (3 beats/section x 8 sections). At
    // the real default of 1.5 facts/beat that is a 36-fact floor.
    beforeEach(() => {
      h.ctx.config = { ...h.ctx.config, llm: { ...h.ctx.config.llm, researchMinFactsPerBeat: 1.5 } }
    })

    it('halts when the corpus is thinner than the beats the script writer will target', async () => {
      // Reproduces the real failure: 13 facts gathered for a ~22-24 beat script, well under the
      // floor, which is exactly the corpus that produced a 53%-unsupported script downstream.
      h.providers.llm.json = (async () => ({
        subject: 'Polarimeter to Unify the Corona and Heliosphere',
        entities: ['Solar Orbiter'],
      })) as RunContext['providers']['llm']['json']
      h.providers.research.lookup = async (query) =>
        Array.from({ length: 13 }, (_, i) => fact(`${query} fact ${i}`))

      const outcome = await createResearcherStage().run(h.ctx)

      expect(outcome).toMatchObject({ status: 'halted' })
      const reason = (outcome as { reason: string }).reason
      expect(reason).toMatch(/36/)
      expect(reason).toMatch(/24/)
      expect(reason).toMatch(/facts|floor|grounded/i)
    })

    it('does not halt once the corpus meets the per-beat floor', async () => {
      h.providers.llm.json = (async () => ({
        subject: 'Venus',
        entities: ['Radar astronomy', 'Tidal locking'],
      })) as RunContext['providers']['llm']['json']
      h.providers.research.lookup = async (query) =>
        Array.from({ length: 12 }, (_, i) => fact(`${query} fact ${i}`))

      const outcome = await createResearcherStage().run(h.ctx)

      expect(outcome).toEqual({ status: 'done' })
      const research = await h.ctx.artifacts.read('research', ResearchSchema)
      expect(research.facts.length).toBeGreaterThanOrEqual(36)
    })
  })
})
