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
      sourceFact: 1,
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

  it('maps a claim citing a valid fact index to that fact\'s real sourceUrl', async () => {
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse({
        claims: [{ text: 'Venus spins backwards.', verdict: 'supported', sourceFact: 1 }],
      })) as RunContext['providers']['llm']['json']

    await expect(createFactCheckerStage().run(h.ctx)).resolves.toEqual({ status: 'done' })

    const report = await h.ctx.artifacts.read('factcheck', FactCheckSchema)
    expect(report.claims[0]!.sourceUrl).toBe('https://en.wikipedia.org/wiki/Venus')
  })

  it('drops the citation without throwing when the model cites an out-of-range fact index', async () => {
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse({
        // Only one fact exists in the fixture (index 1); 7 does not exist.
        claims: [{ text: 'Venus spins backwards.', verdict: 'supported', sourceFact: 7 }],
      })) as RunContext['providers']['llm']['json']

    await expect(createFactCheckerStage().run(h.ctx)).resolves.toEqual({ status: 'done' })

    const report = await h.ctx.artifacts.read('factcheck', FactCheckSchema)
    // A bad index drops the citation but must not change the verdict or fail the batch.
    expect(report.claims[0]!.sourceUrl).toBeUndefined()
    expect(report.claims[0]!.verdict).toBe('supported')
    expect(report.failureRatio).toBe(0)
  })

  it('gives an unsupported claim no citation even if the model supplies a fact index', async () => {
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse({
        claims: [{ text: 'A made-up claim.', verdict: 'unsupported', sourceFact: 1 }],
      })) as RunContext['providers']['llm']['json']

    await createFactCheckerStage().run(h.ctx)

    const report = await h.ctx.artifacts.read('factcheck', FactCheckSchema)
    expect(report.claims[0]!.sourceUrl).toBeUndefined()
  })

  it('writes an artifact that validates against FactCheckSchema, whose sourceUrl requires a well-formed URL', async () => {
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse({
        claims: [{ text: 'Venus spins backwards.', verdict: 'supported', sourceFact: 1 }],
      })) as RunContext['providers']['llm']['json']

    await createFactCheckerStage().run(h.ctx)

    // artifacts.read already validates with FactCheckSchema; a fabricated or malformed
    // sourceUrl would have failed this .url() check before the assertion below ever runs.
    const report = await h.ctx.artifacts.read('factcheck', FactCheckSchema)
    expect(() => new URL(report.claims[0]!.sourceUrl!)).not.toThrow()
  })

  it('dedupes identical claim text before computing the failure ratio', async () => {
    // Reproduces a real run: the model extracted the same claim text four times over (17 total,
    // only 14 distinct: 8 supported, 6 unsupported), which inflated the reported failure ratio
    // to 53% (9 failed / 17) instead of the true 43% (6 failed / 14) — both above the 15%
    // threshold here, but the halt reason must cite the true, deduped numbers.
    const repeatedUnsupported = {
      text: 'The spacecraft must navigate the Van Allen radiation belts.',
      verdict: 'unsupported' as const,
    }
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse({
        claims: [
          ...Array.from({ length: 8 }, (_, i) => ({
            text: `Supported claim ${i}.`,
            verdict: 'supported' as const,
            sourceFact: 1,
          })),
          repeatedUnsupported,
          repeatedUnsupported,
          repeatedUnsupported,
          repeatedUnsupported,
          ...Array.from({ length: 5 }, (_, i) => ({
            text: `Distinct unsupported claim ${i}.`,
            verdict: 'unsupported' as const,
          })),
        ],
      })) as RunContext['providers']['llm']['json']

    const outcome = await createFactCheckerStage().run(h.ctx)

    const report = await h.ctx.artifacts.read('factcheck', FactCheckSchema)
    expect(report.claims).toHaveLength(14)
    expect(report.failureRatio).toBeCloseTo(6 / 14)
    expect(outcome).toMatchObject({ status: 'halted' })
  })

  it('dedupes on normalized text, ignoring case and surrounding/collapsed whitespace', async () => {
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse({
        claims: [
          { text: '  The rover landed  safely.', verdict: 'supported', sourceFact: 1 },
          { text: 'the rover landed safely.', verdict: 'unsupported' },
        ],
      })) as RunContext['providers']['llm']['json']

    await createFactCheckerStage().run(h.ctx)

    const report = await h.ctx.artifacts.read('factcheck', FactCheckSchema)
    // Only the first occurrence survives, keeping its original (supported) verdict.
    expect(report.claims).toHaveLength(1)
    expect(report.claims[0]!.verdict).toBe('supported')
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
