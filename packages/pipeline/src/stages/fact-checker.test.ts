import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FactCheckSchema, MAX_FAILURE_RATIO, ResearchSchema, ScriptSchema, SECTION_KINDS, type RunContext } from '@yt/core'
import { buildFactCheckPrompt, createFactCheckerStage } from '@yt/pipeline'
import { makeStageContext, type StageHarness } from '../../../../test/fixtures/stage-context'

let h: StageHarness

const claims = (supported: number, failed: number) => ({
  claims: [
    ...Array.from({ length: supported }, (_, i) => ({
      text: `Supported claim ${i}.`,
      verdict: 'supported' as const,
      sourceUrl: 'https://en.wikipedia.org/wiki/Venus',
    })),
    ...Array.from({ length: failed }, (_, i) => ({
      text: `Unsupported claim ${i}.`,
      verdict: 'unsupported' as const,
    })),
  ],
})

beforeEach(async () => {
  h = await makeStageContext()
  await h.ctx.artifacts.write('script', ScriptSchema, {
    topicTitle: 'Why Venus rotates backwards',
    sections: SECTION_KINDS.map((kind) => ({
      kind,
      beats: [{ id: kind, text: `Narration for ${kind}.`, targetSeconds: 20 }],
    })),
  })
  await h.ctx.artifacts.write('research', ResearchSchema, {
    topicTitle: 'Why Venus rotates backwards',
    facts: [{ text: 'Venus rotates in the opposite direction to most planets.', sourceUrl: 'https://en.wikipedia.org/wiki/Venus' }],
  })
})
afterEach(async () => {
  await h.cleanup()
})

describe('buildFactCheckPrompt', () => {
  it('includes both the narration and the facts it must be checked against', () => {
    const prompt = buildFactCheckPrompt({ beats: ['Narration one.'], facts: ['Fact one.'] })
    expect(prompt).toContain('Narration one.')
    expect(prompt).toContain('Fact one.')
  })

  it('names all three verdicts', () => {
    const prompt = buildFactCheckPrompt({ beats: ['b'], facts: ['f'] })
    for (const v of ['supported', 'unsupported', 'contradicted']) expect(prompt).toContain(v)
  })
})

describe('createFactCheckerStage', () => {
  it('writes the report and continues when everything is supported', async () => {
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse(claims(10, 0))) as RunContext['providers']['llm']['json']

    await expect(createFactCheckerStage().run(h.ctx)).resolves.toEqual({ status: 'done' })

    const report = await h.ctx.artifacts.read('factcheck', FactCheckSchema)
    expect(report.failureRatio).toBe(0)
    expect(report.claims).toHaveLength(10)
  })

  it('computes the failure ratio from unsupported and contradicted claims together', async () => {
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse(claims(9, 1))) as RunContext['providers']['llm']['json']

    await createFactCheckerStage().run(h.ctx)

    const report = await h.ctx.artifacts.read('factcheck', FactCheckSchema)
    expect(report.failureRatio).toBeCloseTo(0.1)
  })

  it('halts when the failure ratio exceeds the threshold', async () => {
    // 8 supported, 2 failed = 0.2, above the 0.15 threshold.
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse(claims(8, 2))) as RunContext['providers']['llm']['json']

    const outcome = await createFactCheckerStage().run(h.ctx)

    expect(outcome).toMatchObject({ status: 'halted' })
    expect((outcome as { reason: string }).reason).toContain('20')
  })

  it('still writes the report when it halts, so the failure is inspectable', async () => {
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse(claims(8, 2))) as RunContext['providers']['llm']['json']

    await createFactCheckerStage().run(h.ctx)

    await expect(h.ctx.artifacts.exists('factcheck')).resolves.toBe(true)
  })

  it('accepts a claim whose sourceUrl is not a well-formed URL, rather than discarding the whole batch', async () => {
    // Reproduces a real qwen3:8b run: the model is only ever given each fact's *text*, never
    // its sourceUrl (see ResearchSchema), so it has no real citation to copy for a "supported"
    // claim and can only approximate one. Requiring strict `.url()` formatting here burned the
    // stage's entire retry budget rejecting an otherwise fully-scored, valid batch of claims —
    // 3 attempts of 3 stage retries each, all discarded over this cosmetic field alone.
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse({
        claims: [
          { text: 'A supported claim.', verdict: 'supported', sourceUrl: 'NASA, official site' },
          { text: 'Another supported claim.', verdict: 'supported', sourceUrl: 'nasa.gov' },
        ],
      })) as RunContext['providers']['llm']['json']

    await expect(createFactCheckerStage().run(h.ctx)).resolves.toEqual({ status: 'done' })

    const report = await h.ctx.artifacts.read('factcheck', FactCheckSchema)
    expect(report.claims).toHaveLength(2)
    expect(report.failureRatio).toBe(0)
  })

  it('accepts a ratio exactly at the threshold rather than halting on it', async () => {
    // 17 supported, 3 failed = 0.15 exactly. The rule is "more than 15%".
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse(claims(17, 3))) as RunContext['providers']['llm']['json']

    const outcome = await createFactCheckerStage().run(h.ctx)

    expect(outcome).toEqual({ status: 'done' })
    expect(MAX_FAILURE_RATIO).toBe(0.15)
  })
})
