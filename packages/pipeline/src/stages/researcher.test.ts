import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ResearchSchema, TopicSchema, type RunContext } from '@yt/core'
import { createResearcherStage, buildEntityPrompt } from '@yt/pipeline'
import { makeStageContext, type StageHarness } from '../../../../test/fixtures/stage-context'

let h: StageHarness

const writeTopic = async (harness: StageHarness) => {
  await harness.ctx.artifacts.write('topic', TopicSchema, {
    key: 'venus',
    title: 'Why Venus rotates backwards',
    source: 'wikipedia-top',
    url: 'https://en.wikipedia.org/wiki/Venus',
    angle: 'Follow the radar measurement that revealed the retrograde spin.',
    scores: { curiosity: 9, explainability: 8, visualPotential: 7, evergreen: 9 },
    total: 33,
  })
}

beforeEach(async () => {
  h = await makeStageContext()
  await writeTopic(h)
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
})

describe('createResearcherStage', () => {
  it('writes facts gathered for every entity the model named', async () => {
    h.providers.llm.json = (async () => ({ entities: ['Venus', 'Radar astronomy'] })) as RunContext['providers']['llm']['json']
    const asked: string[] = []
    h.providers.research.lookup = async (query) => {
      asked.push(query)
      return [{ text: `A sufficiently long grounding fact about ${query} here.`, sourceUrl: 'https://en.wikipedia.org/wiki/X' }]
    }

    await expect(createResearcherStage().run(h.ctx)).resolves.toEqual({ status: 'done' })

    // The stage always prepends the topic title, so three entities are looked up, not two.
    expect(asked).toEqual(['Why Venus rotates backwards', 'Venus', 'Radar astronomy'])
    const research = await h.ctx.artifacts.read('research', ResearchSchema)
    expect(research.topicTitle).toBe('Why Venus rotates backwards')
    expect(research.facts).toHaveLength(3)
  })

  it('always researches the topic title even if the model omits it', async () => {
    h.providers.llm.json = (async () => ({ entities: ['Radar astronomy'] })) as RunContext['providers']['llm']['json']
    const asked: string[] = []
    h.providers.research.lookup = async (query) => {
      asked.push(query)
      return [{ text: `A sufficiently long grounding fact about ${query} here.`, sourceUrl: 'https://en.wikipedia.org/wiki/X' }]
    }

    await createResearcherStage().run(h.ctx)

    expect(asked).toContain('Why Venus rotates backwards')
  })

  it('deduplicates identical facts returned for different entities', async () => {
    h.providers.llm.json = (async () => ({ entities: ['Venus', 'Venus planet'] })) as RunContext['providers']['llm']['json']
    h.providers.research.lookup = async () => [
      { text: 'The very same grounding fact returned twice over.', sourceUrl: 'https://en.wikipedia.org/wiki/Venus' },
    ]

    await createResearcherStage().run(h.ctx)

    const research = await h.ctx.artifacts.read('research', ResearchSchema)
    expect(research.facts).toHaveLength(1)
  })

  it('halts when no entity produced a single fact, since the script would be ungrounded', async () => {
    h.providers.llm.json = (async () => ({ entities: ['Venus'] })) as RunContext['providers']['llm']['json']
    h.providers.research.lookup = async () => []

    const outcome = await createResearcherStage().run(h.ctx)

    expect(outcome).toMatchObject({ status: 'halted' })
    expect((outcome as { reason: string }).reason).toMatch(/no facts|ungrounded/i)
  })

  it('survives one entity lookup failing and keeps the facts from the others', async () => {
    h.providers.llm.json = (async () => ({ entities: ['Good', 'Bad'] })) as RunContext['providers']['llm']['json']
    h.providers.research.lookup = async (query) => {
      if (query === 'Bad') throw new Error('lookup exploded')
      return [{ text: `A sufficiently long grounding fact about ${query} here.`, sourceUrl: 'https://en.wikipedia.org/wiki/X' }]
    }

    const outcome = await createResearcherStage().run(h.ctx)

    expect(outcome).toEqual({ status: 'done' })
    const research = await h.ctx.artifacts.read('research', ResearchSchema)
    expect(research.facts.some((f) => f.text.includes('Good'))).toBe(true)
  })
})
