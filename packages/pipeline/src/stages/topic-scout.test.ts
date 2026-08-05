import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TopicSchema, type RunContext, type TopicCandidate } from '@yt/core'
import { createTopicScoutStage, buildTopicScoutPrompt, selectCandidatesForScoring } from '@yt/pipeline'
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
      chosen: { key: 'key-1', angle: 'Follow the measurement that overturned the assumption.' },
    })) as RunContext['providers']['llm']['json']

    await expect(createTopicScoutStage().run(h.ctx)).resolves.toEqual({ status: 'done' })

    const topic = await h.ctx.artifacts.read('topic', TopicSchema)
    expect(topic.title).toBe('High pick')
    expect(topic.total).toBe(34)
    expect(topic.angle).toMatch(/measurement/)
  })

  it('computes total from the four scores rather than requiring the model to sum them itself', async () => {
    // Reproduces a real qwen3:8b response: every candidate had correct per-dimension scores
    // but no "total" key at all — the model got the scoring right and just never summed it.
    h.providers.trend.fetchCandidates = async () => candidates('Low pick', 'High pick')
    h.providers.llm.json = (async () => ({
      candidates: [
        { key: 'key-0', title: 'Low pick', scores: { curiosity: 2, explainability: 2, visualPotential: 2, evergreen: 2 } },
        { key: 'key-1', title: 'High pick', scores: { curiosity: 9, explainability: 8, visualPotential: 8, evergreen: 9 } },
      ],
      chosen: { key: 'key-1', angle: 'Follow the measurement that overturned the assumption.' },
    })) as RunContext['providers']['llm']['json']

    await expect(createTopicScoutStage().run(h.ctx)).resolves.toEqual({ status: 'done' })

    const topic = await h.ctx.artifacts.read('topic', TopicSchema)
    expect(topic.title).toBe('High pick')
    expect(topic.total).toBe(34)
  })

  it('records the chosen topic as used so it can never be picked again', async () => {
    h.providers.trend.fetchCandidates = async () => candidates('Only option')
    h.providers.llm.json = (async () => ({
      candidates: [{ key: 'key-0', title: 'Only option', scores: { curiosity: 5, explainability: 5, visualPotential: 5, evergreen: 5 }, total: 20 }],
      chosen: { key: 'key-0', angle: 'An angle.' },
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
        chosen: { key: 'key-1', angle: 'An angle.' },
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

  it('falls back to a generic angle, not the model\'s mismatched one, when chosenKey was never offered', async () => {
    // Reproduces the shape of a real qwen3:8b failure: the model can write a coherent-looking
    // chosen.angle that is actually about a candidate other than the one it names by key. This
    // covers the case where that named key is not even in the offered list.
    h.providers.trend.fetchCandidates = async () => candidates('A', 'B')
    h.providers.llm.json = (async () => ({
      candidates: [
        { key: 'key-0', title: 'A', scores: { curiosity: 3, explainability: 3, visualPotential: 3, evergreen: 3 } },
        { key: 'key-1', title: 'B', scores: { curiosity: 9, explainability: 9, visualPotential: 9, evergreen: 9 } },
      ],
      chosen: { key: 'a-key-that-does-not-exist', angle: 'This angle is actually about something else entirely.' },
    })) as RunContext['providers']['llm']['json']

    await createTopicScoutStage().run(h.ctx)

    const topic = await h.ctx.artifacts.read('topic', TopicSchema)
    expect(topic.key).toBe('key-1')
    expect(topic.angle).not.toContain('something else entirely')
    expect(topic.angle).toContain('B')
  })

  it('falls back to the highest total when the model chooses a key it was not offered', async () => {
    h.providers.trend.fetchCandidates = async () => candidates('A', 'B')
    h.providers.llm.json = (async () => ({
      candidates: [
        { key: 'key-0', title: 'A', scores: { curiosity: 3, explainability: 3, visualPotential: 3, evergreen: 3 }, total: 12 },
        { key: 'key-1', title: 'B', scores: { curiosity: 9, explainability: 9, visualPotential: 9, evergreen: 9 }, total: 36 },
      ],
      chosen: { key: 'a-key-that-does-not-exist', angle: 'An angle.' },
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
      chosen: { key: 'key-0', angle: 'An angle.' },
    })) as RunContext['providers']['llm']['json']

    await createTopicScoutStage().run(h.ctx)

    expect(asked[0]).toEqual(h.ctx.config.nicheConfig.trendSources)
  })

  it('caps the candidates offered to the model at the configured max, not the full fresh pool', async () => {
    h.ctx.config.llm.topicScoutMaxCandidates = 3
    const titles = ['Titan lakes', 'Betelgeuse collapse', 'Voyager gap', 'Pulsar timing', 'Dark flow']
    h.providers.trend.fetchCandidates = async () => candidates(...titles)
    let seenPrompt = ''
    h.providers.llm.json = (async (prompt: string) => {
      seenPrompt = prompt
      return {
        candidates: [{ key: 'key-0', title: titles[0], scores: { curiosity: 5, explainability: 5, visualPotential: 5, evergreen: 5 }, total: 20 }],
        chosen: { key: 'key-0', angle: 'An angle.' },
      }
    }) as RunContext['providers']['llm']['json']

    await createTopicScoutStage().run(h.ctx)

    const offeredCount = titles.filter((t) => seenPrompt.includes(t)).length
    expect(offeredCount).toBe(3)
  })

  it('passes the configured temperature through to the scoring call', async () => {
    h.ctx.config.llm.temperature = 0.42
    h.providers.trend.fetchCandidates = async () => candidates('Only option')
    let seenOpts: unknown
    h.providers.llm.json = (async (
      _prompt: string,
      _schemaName: string,
      _parse: unknown,
      opts: unknown,
    ) => {
      seenOpts = opts
      return {
        candidates: [{ key: 'key-0', title: 'Only option', scores: { curiosity: 5, explainability: 5, visualPotential: 5, evergreen: 5 }, total: 20 }],
        chosen: { key: 'key-0', angle: 'An angle.' },
      }
    }) as RunContext['providers']['llm']['json']

    await createTopicScoutStage().run(h.ctx)

    expect(seenOpts).toEqual({ temperature: 0.42 })
  })
})

describe('selectCandidatesForScoring', () => {
  it('returns every candidate unchanged when the pool is already within the cap', () => {
    const pool = candidates('A', 'B')
    expect(selectCandidatesForScoring(pool, 5)).toEqual(pool)
  })

  it('interleaves sources round-robin rather than draining one source first', () => {
    const pool: TopicCandidate[] = [
      { key: 'w1', title: 'W1', source: 'wikipedia-top', url: null },
      { key: 'w2', title: 'W2', source: 'wikipedia-top', url: null },
      { key: 'w3', title: 'W3', source: 'wikipedia-top', url: null },
      { key: 'a1', title: 'A1', source: 'arxiv', url: null },
      { key: 'a2', title: 'A2', source: 'arxiv', url: null },
    ]

    const picked = selectCandidatesForScoring(pool, 4)

    expect(picked.map((c) => c.key)).toEqual(['w1', 'a1', 'w2', 'a2'])
  })

  it('preserves each source\'s own order among the candidates it keeps', () => {
    const pool: TopicCandidate[] = [
      { key: 'w1', title: 'W1', source: 'wikipedia-top', url: null },
      { key: 'w2', title: 'W2', source: 'wikipedia-top', url: null },
      { key: 'w3', title: 'W3', source: 'wikipedia-top', url: null },
    ]

    expect(selectCandidatesForScoring(pool, 2).map((c) => c.key)).toEqual(['w1', 'w2'])
  })
})
