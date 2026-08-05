import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FactCheckSchema, MAX_FAILURE_RATIO, ResearchSchema, ScriptSchema, SECTION_KINDS, type RunContext } from '@yt/core'
import { buildFactCheckPrompt, createFactCheckerStage } from '@yt/pipeline'
import { makeStageContext, type StageHarness } from '../../../../test/fixtures/stage-context'

let h: StageHarness

const claims = (supported: number, failed: number) => ({
  claims: [
    ...Array.from({ length: supported }, (_, i) => ({
      text: `Supported claim ${i}.`,
      type: 'factual' as const,
      verdict: 'supported' as const,
      sourceFact: 1,
    })),
    ...Array.from({ length: failed }, (_, i) => ({
      text: `Unsupported claim ${i}.`,
      type: 'factual' as const,
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

  it('asks the model to label each claim with a type, not merely to skip non-factual ones', () => {
    const prompt = buildFactCheckPrompt({ beats: ['b'], facts: ['f'] })
    expect(prompt).toContain('"type"')
    for (const t of ['factual', 'rhetorical', 'opinion', 'narrative']) expect(prompt).toContain(t)
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
        claims: [{ text: 'Venus spins backwards.', type: 'factual', verdict: 'supported', sourceFact: 1 }],
      })) as RunContext['providers']['llm']['json']

    await expect(createFactCheckerStage().run(h.ctx)).resolves.toEqual({ status: 'done' })

    const report = await h.ctx.artifacts.read('factcheck', FactCheckSchema)
    expect(report.claims[0]!.sourceUrl).toBe('https://en.wikipedia.org/wiki/Venus')
  })

  it('drops the citation without throwing when the model cites an out-of-range fact index', async () => {
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse({
        // Only one fact exists in the fixture (index 1); 7 does not exist.
        claims: [{ text: 'Venus spins backwards.', type: 'factual', verdict: 'supported', sourceFact: 7 }],
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
        claims: [{ text: 'A made-up claim.', type: 'factual', verdict: 'unsupported', sourceFact: 1 }],
      })) as RunContext['providers']['llm']['json']

    await createFactCheckerStage().run(h.ctx)

    const report = await h.ctx.artifacts.read('factcheck', FactCheckSchema)
    expect(report.claims[0]!.sourceUrl).toBeUndefined()
  })

  it('writes an artifact that validates against FactCheckSchema, whose sourceUrl requires a well-formed URL', async () => {
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse({
        claims: [{ text: 'Venus spins backwards.', type: 'factual', verdict: 'supported', sourceFact: 1 }],
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
      type: 'factual' as const,
      verdict: 'unsupported' as const,
    }
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse({
        claims: [
          ...Array.from({ length: 8 }, (_, i) => ({
            text: `Supported claim ${i}.`,
            type: 'factual' as const,
            verdict: 'supported' as const,
            sourceFact: 1,
          })),
          repeatedUnsupported,
          repeatedUnsupported,
          repeatedUnsupported,
          repeatedUnsupported,
          ...Array.from({ length: 5 }, (_, i) => ({
            text: `Distinct unsupported claim ${i}.`,
            type: 'factual' as const,
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
          { text: '  The rover landed  safely.', type: 'factual', verdict: 'supported', sourceFact: 1 },
          { text: 'the rover landed safely.', type: 'factual', verdict: 'unsupported' },
        ],
      })) as RunContext['providers']['llm']['json']

    await createFactCheckerStage().run(h.ctx)

    const report = await h.ctx.artifacts.read('factcheck', FactCheckSchema)
    // Only the first occurrence survives, keeping its original (supported) verdict.
    expect(report.claims).toHaveLength(1)
    expect(report.claims[0]!.verdict).toBe('supported')
  })

  describe('dropping non-factual claims before scoring', () => {
    it('drops a rhetorical question entirely rather than scoring it as unsupported', async () => {
      // Reproduces a real failure: "How will the rocket part interact with the Moon's
      // surface? What will it look like?" was extracted and reported unsupported, even though
      // a rhetorical question asserts nothing a source could ever confirm.
      h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
        parse({
          claims: [
            { text: 'Venus rotates in the opposite direction to most planets.', type: 'factual', verdict: 'supported', sourceFact: 1 },
            { text: 'What will it look like?', type: 'rhetorical', verdict: 'unsupported' },
          ],
        })) as RunContext['providers']['llm']['json']

      await expect(createFactCheckerStage().run(h.ctx)).resolves.toEqual({ status: 'done' })

      const report = await h.ctx.artifacts.read('factcheck', FactCheckSchema)
      expect(report.claims).toHaveLength(1)
      expect(report.claims.some((c) => c.text === 'What will it look like?')).toBe(false)
      expect(report.failureRatio).toBe(0)
    })

    it('drops narrative framing and opinion claims the same way', async () => {
      h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
        parse({
          claims: [
            { text: 'Venus rotates in the opposite direction to most planets.', type: 'factual', verdict: 'supported', sourceFact: 1 },
            {
              text: 'This observation is more than just a scientific experiment. It is a bridge between past and present.',
              type: 'narrative',
              verdict: 'unsupported',
            },
            { text: 'The impact itself is a mystery.', type: 'opinion', verdict: 'unsupported' },
          ],
        })) as RunContext['providers']['llm']['json']

      await createFactCheckerStage().run(h.ctx)

      const report = await h.ctx.artifacts.read('factcheck', FactCheckSchema)
      expect(report.claims).toHaveLength(1)
      expect(report.failureRatio).toBe(0)
    })

    it('logs how many non-factual claims were dropped and out of how many extracted', async () => {
      h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
        parse({
          claims: [
            { text: 'Venus rotates in the opposite direction to most planets.', type: 'factual', verdict: 'supported', sourceFact: 1 },
            { text: 'What will it look like?', type: 'rhetorical', verdict: 'unsupported' },
            { text: 'A testament to human ingenuity.', type: 'opinion', verdict: 'unsupported' },
          ],
        })) as RunContext['providers']['llm']['json']

      await createFactCheckerStage().run(h.ctx)

      expect(h.logs.some((l) => l.message.includes('dropped 2 non-factual claim(s) of 3 extracted'))).toBe(true)
    })

    it('still counts a genuinely false factual claim as a failure — dropping non-factual types is not a loophole', async () => {
      // The critical guard: a real, checkable, unsupported factual assertion must still be
      // caught even after rhetorical/opinion/narrative claims are filtered out. Dropping the
      // wrong types must never mean dropping a real grounding failure.
      h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
        parse({
          claims: [
            { text: 'Venus rotates in the opposite direction to most planets.', type: 'factual', verdict: 'supported', sourceFact: 1 },
            // A fabricated, checkable factual claim the permitted facts neither state nor imply.
            { text: 'Venus completes one rotation every 42 Earth days.', type: 'factual', verdict: 'unsupported' },
            { text: 'What a fascinating world Venus is.', type: 'opinion', verdict: 'unsupported' },
          ],
        })) as RunContext['providers']['llm']['json']

      const outcome = await createFactCheckerStage().run(h.ctx)

      const report = await h.ctx.artifacts.read('factcheck', FactCheckSchema)
      expect(report.claims).toHaveLength(2)
      expect(report.claims.some((c) => c.text.includes('42 Earth days') && c.verdict === 'unsupported')).toBe(true)
      expect(report.failureRatio).toBeCloseTo(0.5)
      // 1 of 2 factual claims failed (50%), above the 15% threshold — the run must still halt.
      expect(outcome).toMatchObject({ status: 'halted' })
    })
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
