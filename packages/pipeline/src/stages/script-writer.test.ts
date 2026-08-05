import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FORMAT_PRESETS, ResearchSchema, ScriptSchema, SECTION_KINDS, TopicSchema, type RunContext } from '@yt/core'
import { buildScriptPrompt, createScriptWriterStage, SECONDS_PER_BEAT_HINT } from '@yt/pipeline'
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

    // Default config: duration: 8 (minutes) -> 480s, which is exactly the long preset's floor,
    // so it clamps to 480 (not the old preset-midpoint 540). See batch-c-fixes-report for the
    // full sweep: every in-range duration still resolves to 3 beats/section (528s predicted,
    // inside the 480-600s preset window) -- duration changes the stated target/word count, not
    // the beat structure.
    expect(seenPrompt).toContain('480')
  })

  it('derives targetSeconds from the configured duration, not just the preset midpoint', async () => {
    h.ctx.config.duration = 9 // minutes -> 540s, well inside the 480-600s long preset window
    let seenPrompt = ''
    h.providers.llm.json = (async (p: string, _n: string, parse: (raw: unknown) => unknown) => {
      seenPrompt = p
      return parse(validScript())
    }) as RunContext['providers']['llm']['json']

    await createScriptWriterStage().run(h.ctx)

    expect(seenPrompt).toContain('540')
    // word target = targetSeconds * 2.5 (150 wpm)
    expect(seenPrompt).toContain('1350')
  })

  it('clamps an out-of-range duration into the preset bounds', async () => {
    h.ctx.config.duration = 100 // minutes -> 6000s, far above the 600s preset ceiling
    let seenPrompt = ''
    h.providers.llm.json = (async (p: string, _n: string, parse: (raw: unknown) => unknown) => {
      seenPrompt = p
      return parse(validScript())
    }) as RunContext['providers']['llm']['json']

    await createScriptWriterStage().run(h.ctx)

    expect(seenPrompt).toContain('600')
    expect(seenPrompt).not.toContain('6000')
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

  it('ignores configured duration entirely for shorts, always targeting the preset midpoint', async () => {
    const shorts = await makeStageContext({ videoType: 'shorts', runId: 'run-shorts-duration' })
    shorts.ctx.config.duration = 60 // minutes -- would be way outside the shorts preset if honoured
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

    expect(seenPrompt).toContain('150')
    expect(seenPrompt).not.toContain('3600') // 60 minutes in seconds, if duration leaked through
    await shorts.cleanup()
  })

  it('holds the duration/word-count/beat invariant across the whole long-form duration range', async () => {
    const { minDurationSec, maxDurationSec } = FORMAT_PRESETS.long

    // Sweep well below, across and well above the preset's allowed window (minutes).
    const durationsMin = [1, 5, 7, 7.9, 8, 8.5, 9, 9.5, 10, 10.5, 11, 15, 100]

    for (const durationMin of durationsMin) {
      h.ctx.config.duration = durationMin
      h.logs.length = 0 // each iteration reuses the same harness; only look at this run's logs
      let seenPrompt = ''
      h.providers.llm.json = (async (p: string, _n: string, parse: (raw: unknown) => unknown) => {
        seenPrompt = p
        return parse(validScript())
      }) as RunContext['providers']['llm']['json']

      await createScriptWriterStage().run(h.ctx)

      const infoLog = h.logs.find((l) => l.message.startsWith('writing a ~'))
      const match = infoLog?.message.match(/writing a ~(\d+)s script: (\d+) beats per section/)
      expect(match, `no beat-budget log line for duration=${durationMin}min`).toBeTruthy()
      const targetSeconds = Number(match![1])
      const beatsPerSection = Number(match![2])

      // targetSeconds must be the clamped configured duration.
      const expectedTargetSeconds = Math.min(
        maxDurationSec,
        Math.max(minDurationSec, Math.round(durationMin * 60)),
      )
      expect(targetSeconds).toBe(expectedTargetSeconds)

      // The stated word target must be exactly targetSeconds x 2.5 (150 wpm).
      const wordMatch = seenPrompt.match(/roughly (\d+) words total/)
      expect(wordMatch, `no total word target in prompt for duration=${durationMin}min`).toBeTruthy()
      expect(Number(wordMatch![1])).toBe(Math.round(targetSeconds * 2.5))

      // The duration predicted from the beat budget (total beats x per-beat seconds hint) must
      // land inside the preset's own window -- otherwise the beat structure the model is asked
      // to produce can't actually carry a video of the stated length.
      const totalBeats = beatsPerSection * SECTION_KINDS.length
      const predictedSeconds = totalBeats * SECONDS_PER_BEAT_HINT
      expect(predictedSeconds).toBeGreaterThanOrEqual(minDurationSec)
      expect(predictedSeconds).toBeLessThanOrEqual(maxDurationSec)
    }
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
