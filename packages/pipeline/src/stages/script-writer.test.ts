import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ResearchSchema, ScriptSchema, SECTION_KINDS, TopicSchema, type RunContext } from '@yt/core'
import { buildScriptPrompt, createScriptWriterStage } from '@yt/pipeline'
import { makeStageContext, type StageHarness } from '../../../../test/fixtures/stage-context'

let h: StageHarness

const validScript = (beatsPerSection = 3) => ({
  topicTitle: 'Why Venus rotates backwards',
  sections: SECTION_KINDS.map((kind) => ({
    kind,
    beats: Array.from({ length: beatsPerSection }, (_, i) => ({
      id: `${kind}-${i}`,
      text: `Narration for ${kind} beat ${i}.`,
      targetSeconds: 25,
    })),
  })),
})

beforeEach(async () => {
  h = await makeStageContext({ videoType: 'long' })
  await h.ctx.artifacts.write('topic', TopicSchema, {
    key: 'venus',
    title: 'Why Venus rotates backwards',
    source: 'wikipedia-top',
    url: 'https://en.wikipedia.org/wiki/Venus',
    angle: 'Follow the radar measurement that revealed the retrograde spin.',
    scores: { curiosity: 9, explainability: 8, visualPotential: 7, evergreen: 9 },
    total: 33,
  })
  await h.ctx.artifacts.write('research', ResearchSchema, {
    topicTitle: 'Why Venus rotates backwards',
    facts: [
      { text: 'Venus rotates in the opposite direction to most planets in the Solar System.', sourceUrl: 'https://en.wikipedia.org/wiki/Venus' },
      { text: 'Radar observations in the 1960s established the retrograde rotation.', sourceUrl: 'https://en.wikipedia.org/wiki/Radar_astronomy' },
    ],
  })
})
afterEach(async () => {
  await h.cleanup()
})

describe('buildScriptPrompt', () => {
  it('lists every research fact, because the writer may not invent any', () => {
    const prompt = buildScriptPrompt({
      topicTitle: 'T', angle: 'A',
      facts: ['Fact one.', 'Fact two.'],
      targetSeconds: 540, beatsPerSection: 3,
    })
    expect(prompt).toContain('Fact one.')
    expect(prompt).toContain('Fact two.')
  })

  it('names all eight sections in arc order and states the beat window', () => {
    const prompt = buildScriptPrompt({ topicTitle: 'T', angle: 'A', facts: ['f'], targetSeconds: 540, beatsPerSection: 3 })
    for (const kind of SECTION_KINDS) expect(prompt).toContain(kind)
    expect(prompt).toContain('15')
    expect(prompt).toContain('30')
  })

  it('states the per-section beat budget so the arithmetic is not left implicit', () => {
    const prompt = buildScriptPrompt({ topicTitle: 'T', angle: 'A', facts: ['f'], targetSeconds: 540, beatsPerSection: 3 })
    expect(prompt).toContain('3')
    expect(prompt).toContain('540')
  })
})

describe('createScriptWriterStage', () => {
  it('writes a schema-valid script', async () => {
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse(validScript())) as RunContext['providers']['llm']['json']

    await expect(createScriptWriterStage().run(h.ctx)).resolves.toEqual({ status: 'done' })

    const script = await h.ctx.artifacts.read('script', ScriptSchema)
    expect(script.sections).toHaveLength(8)
    expect(script.sections.map((s) => s.kind)).toEqual([...SECTION_KINDS])
  })

  it('asks for a beat budget derived from the format preset, not a fixed number', async () => {
    let seenPrompt = ''
    h.providers.llm.json = (async (p: string, _n: string, parse: (raw: unknown) => unknown) => {
      seenPrompt = p
      return parse(validScript())
    }) as RunContext['providers']['llm']['json']

    await createScriptWriterStage().run(h.ctx)

    // long preset: 480-600s at ~25s per beat over 8 sections is about 3 beats each.
    expect(seenPrompt).toContain('540')
  })

  it('asks for far fewer beats for a shorts run', async () => {
    const shorts = await makeStageContext({ videoType: 'shorts', runId: 'run-shorts' })
    await shorts.ctx.artifacts.write('topic', TopicSchema, await h.ctx.artifacts.read('topic', TopicSchema))
    await shorts.ctx.artifacts.write('research', ResearchSchema, await h.ctx.artifacts.read('research', ResearchSchema))
    let seenPrompt = ''
    shorts.providers.llm.json = (async (p: string, _n: string, parse: (raw: unknown) => unknown) => {
      seenPrompt = p
      return parse({
        topicTitle: 'Why Venus rotates backwards',
        sections: SECTION_KINDS.map((kind) => ({ kind, beats: [{ id: kind, text: `Beat for ${kind}.`, targetSeconds: 15 }] })),
      })
    }) as RunContext['providers']['llm']['json']

    await createScriptWriterStage().run(shorts.ctx)

    // shorts preset (post Task 1): 120-180s at ~25s per beat over 8 sections is about 1 beat
    // each, targeting the 150s midpoint -- far fewer beats than the long-form 3 per section.
    expect(seenPrompt).toContain('150')
    await shorts.cleanup()
  })

  it('propagates a schema rejection rather than writing a malformed script', async () => {
    // A beat outside 15-30s must not reach disk. The provider owns retrying; when it gives
    // up the stage must fail, not persist something invalid.
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse({
        topicTitle: 'T',
        sections: SECTION_KINDS.map((kind) => ({ kind, beats: [{ id: kind, text: 'x', targetSeconds: 90 }] })),
      })) as RunContext['providers']['llm']['json']

    await expect(createScriptWriterStage().run(h.ctx)).rejects.toThrow()
    await expect(h.ctx.artifacts.exists('script')).resolves.toBe(false)
  })
})
