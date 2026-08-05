import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FactCheckSchema, ResearchSchema, ScriptSchema, SECTION_KINDS, TopicSchema, type RunContext } from '@yt/core'
import { createFactCheckerStage, createScriptWriterStage } from '@yt/pipeline'
import { makeStageContext, type StageHarness } from '../../../../test/fixtures/stage-context'

let h: StageHarness

// A corpus deliberately larger than the configured cap, so a passing test proves the slice
// actually happened rather than trivially matching an uncapped list.
const TOTAL_FACTS = 50
const CAP = 10

const facts = Array.from({ length: TOTAL_FACTS }, (_, i) => ({
  text: `Grounding fact number ${i + 1}.`,
  sourceUrl: 'https://example.com/source',
}))

const validScript = () => ({
  topicTitle: 'T',
  sections: SECTION_KINDS.map((kind) => ({
    kind,
    beats: [{ id: kind, text: `Beat for ${kind}.`, targetSeconds: 20 }],
  })),
})

beforeEach(async () => {
  h = await makeStageContext({ videoType: 'long' })
  h.ctx.config = { ...h.ctx.config, llm: { ...h.ctx.config.llm, maxFactsPerPrompt: CAP } }
  await h.ctx.artifacts.write('topic', TopicSchema, {
    key: 'topic',
    title: 'T',
    source: 'wikipedia-top',
    url: null,
    angle: 'A',
    scores: { curiosity: 5, explainability: 5, visualPotential: 5, evergreen: 5 },
    total: 20,
  })
  await h.ctx.artifacts.write('research', ResearchSchema, { topicTitle: 'T', facts })
})
afterEach(async () => {
  await h.cleanup()
})

describe('script-writer and fact-checker fact parity', () => {
  it('both stages are capped at maxFactsPerPrompt and see the identical leading slice of the corpus', async () => {
    let scriptPrompt = ''
    h.providers.llm.json = (async (p: string, _n: string, parse: (raw: unknown) => unknown) => {
      scriptPrompt = p
      return parse(validScript())
    }) as RunContext['providers']['llm']['json']

    await expect(createScriptWriterStage().run(h.ctx)).resolves.toEqual({ status: 'done' })

    let factCheckPrompt = ''
    h.providers.llm.json = (async (p: string, _n: string, parse: (raw: unknown) => unknown) => {
      factCheckPrompt = p
      return parse({
        claims: [{ text: 'x', type: 'factual' as const, verdict: 'supported' as const, sourceFact: 1 }],
      })
    }) as RunContext['providers']['llm']['json']

    await expect(createFactCheckerStage().run(h.ctx)).resolves.toEqual({ status: 'done' })

    const included = facts.slice(0, CAP).map((f) => f.text)
    const excluded = facts.slice(CAP).map((f) => f.text)

    expect(included).toHaveLength(CAP)
    expect(excluded).toHaveLength(TOTAL_FACTS - CAP)

    for (const text of included) {
      expect(scriptPrompt, `script prompt missing in-cap fact: ${text}`).toContain(text)
      expect(factCheckPrompt, `fact-check prompt missing in-cap fact: ${text}`).toContain(text)
    }
    for (const text of excluded) {
      expect(scriptPrompt, `script prompt leaked out-of-cap fact: ${text}`).not.toContain(text)
      expect(factCheckPrompt, `fact-check prompt leaked out-of-cap fact: ${text}`).not.toContain(text)
    }
  })

  it('raising the cap raises what both stages see, in lockstep', async () => {
    h.ctx.config = { ...h.ctx.config, llm: { ...h.ctx.config.llm, maxFactsPerPrompt: TOTAL_FACTS } }

    let scriptPrompt = ''
    h.providers.llm.json = (async (p: string, _n: string, parse: (raw: unknown) => unknown) => {
      scriptPrompt = p
      return parse(validScript())
    }) as RunContext['providers']['llm']['json']

    await createScriptWriterStage().run(h.ctx)

    let factCheckPrompt = ''
    h.providers.llm.json = (async (p: string, _n: string, parse: (raw: unknown) => unknown) => {
      factCheckPrompt = p
      return parse({
        claims: [{ text: 'x', type: 'factual' as const, verdict: 'supported' as const, sourceFact: 1 }],
      })
    }) as RunContext['providers']['llm']['json']

    await createFactCheckerStage().run(h.ctx)

    for (const fact of facts) {
      expect(scriptPrompt).toContain(fact.text)
      expect(factCheckPrompt).toContain(fact.text)
    }
  })

  it('maps a claim citing an in-cap fact index to that fact\'s real sourceUrl, using the same slice the prompt used', async () => {
    const distinctFacts = Array.from({ length: TOTAL_FACTS }, (_, i) => ({
      text: `Grounding fact number ${i + 1}.`,
      sourceUrl: `https://example.com/source-${i + 1}`,
    }))
    await h.ctx.artifacts.write('research', ResearchSchema, { topicTitle: 'T', facts: distinctFacts })
    await h.ctx.artifacts.write('script', ScriptSchema, validScript())

    // Cite fact index CAP (the last fact inside the cap) -- must resolve to that exact fact's
    // sourceUrl, not some other fact's, proving the checker indexes into the same capped slice
    // the model was actually shown (not the full uncapped research.facts array).
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse({
        claims: [{ text: 'A claim.', type: 'factual' as const, verdict: 'supported' as const, sourceFact: CAP }],
      })) as RunContext['providers']['llm']['json']

    await createFactCheckerStage().run(h.ctx)

    const report = await h.ctx.artifacts.read('factcheck', FactCheckSchema)
    expect(report.claims[0]!.sourceUrl).toBe(`https://example.com/source-${CAP}`)
  })
})
