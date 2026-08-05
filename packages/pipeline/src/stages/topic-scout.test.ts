import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TopicSchema, type RunContext, type TopicCandidate } from '@yt/core'
import { createTopicScoutStage, buildTopicScoutPrompt } from '@yt/pipeline'
import { makeStageContext, type StageHarness } from '../../../../test/fixtures/stage-context'

let h: StageHarness

beforeEach(async () => {
  h = await makeStageContext()
})
afterEach(async () => {
  await h.cleanup()
})

const candidates = (...titles: string[]): TopicCandidate[] =>
  titles.map((title, i) => ({
    key: `key-${i}`,
    title,
    source: 'wikipedia-top' as const,
    url: `https://example.invalid/${i}`,
  }))

describe('buildTopicScoutPrompt', () => {
  it('embeds every candidate title and the niche guidance', () => {
    const prompt = buildTopicScoutPrompt({
      candidates: candidates('Venus rotation', 'Deep sea vents'),
      nicheLabel: 'Space',
      promptGuidance: 'Explain one cosmic phenomenon.',
    })

    expect(prompt).toContain('Venus rotation')
    expect(prompt).toContain('Deep sea vents')
    expect(prompt).toContain('Explain one cosmic phenomenon.')
    expect(prompt).toContain('Space')
  })

  it('asks for all four scoring dimensions by name', () => {
    const prompt = buildTopicScoutPrompt({ candidates: candidates('X'), nicheLabel: 'Space', promptGuidance: 'g' })
    for (const dim of ['curiosity', 'explainability', 'visualPotential', 'evergreen']) {
      expect(prompt).toContain(dim)
    }
  })
})

describe('createTopicScoutStage', () => {
  it('writes the highest-scoring candidate as the topic artifact', async () => {
    h.providers.trend.fetchCandidates = async () => candidates('Low pick', 'High pick')
    h.providers.llm.json = (async () => ({
      candidates: [
        { key: 'key-0', title: 'Low pick', scores: { curiosity: 2, explainability: 2, visualPotential: 2, evergreen: 2 }, total: 8 },
        { key: 'key-1', title: 'High pick', scores: { curiosity: 9, explainability: 8, visualPotential: 8, evergreen: 9 }, total: 34 },
      ],
      chosenKey: 'key-1',
      angle: 'Follow the measurement that overturned the assumption.',
    })) as RunContext['providers']['llm']['json']

    await expect(createTopicScoutStage().run(h.ctx)).resolves.toEqual({ status: 'done' })

    const topic = await h.ctx.artifacts.read('topic', TopicSchema)
    expect(topic.title).toBe('High pick')
    expect(topic.total).toBe(34)
    expect(topic.angle).toMatch(/measurement/)
  })

  it('records the chosen topic as used so it can never be picked again', async () => {
    h.providers.trend.fetchCandidates = async () => candidates('Only option')
    h.providers.llm.json = (async () => ({
      candidates: [{ key: 'key-0', title: 'Only option', scores: { curiosity: 5, explainability: 5, visualPotential: 5, evergreen: 5 }, total: 20 }],
      chosenKey: 'key-0',
      angle: 'An angle.',
    })) as RunContext['providers']['llm']['json']

    await createTopicScoutStage().run(h.ctx)

    expect(await h.repos.topics.hasUsed('key-0')).toBe(true)
  })

  it('never offers the model a topic that was already used', async () => {
    await h.repos.topics.markUsed('key-0', 'Already done')
    h.providers.trend.fetchCandidates = async () => candidates('Already done', 'Fresh one')
    const seen: string[] = []
    h.providers.llm.json = (async (prompt: string) => {
      seen.push(prompt)
      return {
        candidates: [{ key: 'key-1', title: 'Fresh one', scores: { curiosity: 5, explainability: 5, visualPotential: 5, evergreen: 5 }, total: 20 }],
        chosenKey: 'key-1',
        angle: 'An angle.',
      }
    }) as RunContext['providers']['llm']['json']

    await createTopicScoutStage().run(h.ctx)

    expect(seen[0]).not.toContain('Already done')
    expect(seen[0]).toContain('Fresh one')
  })

  it('halts, rather than throwing, when every candidate has been used', async () => {
    await h.repos.topics.markUsed('key-0', 'Used')
    h.providers.trend.fetchCandidates = async () => candidates('Used')

    const outcome = await createTopicScoutStage().run(h.ctx)

    expect(outcome).toMatchObject({ status: 'halted' })
    expect((outcome as { reason: string }).reason).toMatch(/already been used|no unused/i)
  })

  it('halts when no source returned any candidate at all', async () => {
    h.providers.trend.fetchCandidates = async () => []

    const outcome = await createTopicScoutStage().run(h.ctx)

    expect(outcome).toMatchObject({ status: 'halted' })
  })

  it('falls back to the highest total when the model chooses a key it was not offered', async () => {
    h.providers.trend.fetchCandidates = async () => candidates('A', 'B')
    h.providers.llm.json = (async () => ({
      candidates: [
        { key: 'key-0', title: 'A', scores: { curiosity: 3, explainability: 3, visualPotential: 3, evergreen: 3 }, total: 12 },
        { key: 'key-1', title: 'B', scores: { curiosity: 9, explainability: 9, visualPotential: 9, evergreen: 9 }, total: 36 },
      ],
      chosenKey: 'a-key-that-does-not-exist',
      angle: 'An angle.',
    })) as RunContext['providers']['llm']['json']

    await createTopicScoutStage().run(h.ctx)

    const topic = await h.ctx.artifacts.read('topic', TopicSchema)
    expect(topic.key).toBe('key-1')
  })

  it('requests only the trend sources the niche config names', async () => {
    const asked: unknown[] = []
    h.providers.trend.fetchCandidates = async (sources) => {
      asked.push([...sources])
      return candidates('X')
    }
    h.providers.llm.json = (async () => ({
      candidates: [{ key: 'key-0', title: 'X', scores: { curiosity: 5, explainability: 5, visualPotential: 5, evergreen: 5 }, total: 20 }],
      chosenKey: 'key-0',
      angle: 'An angle.',
    })) as RunContext['providers']['llm']['json']

    await createTopicScoutStage().run(h.ctx)

    expect(asked[0]).toEqual(h.ctx.config.nicheConfig.trendSources)
  })
})
