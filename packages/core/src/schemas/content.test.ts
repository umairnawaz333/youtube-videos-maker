import { describe, expect, it } from 'vitest'
import { ScriptSchema, ScenePlanSchema, SeoSchema, SECTION_KINDS, TopicSchema } from '@yt/core'

const beat = (seconds: number) => ({ id: 'b1', text: 'Narration line.', targetSeconds: seconds })

const script = (overrides: Record<string, unknown> = {}) => ({
  topicTitle: 'Why Venus spins backwards',
  sections: SECTION_KINDS.map((kind) => ({ kind, beats: [beat(20)] })),
  ...overrides,
})

describe('ScriptSchema', () => {
  it('accepts the eight-section arc', () => {
    expect(ScriptSchema.safeParse(script()).success).toBe(true)
  })

  it('rejects a beat shorter than fifteen seconds', () => {
    const bad = script({
      sections: SECTION_KINDS.map((kind) => ({ kind, beats: [beat(kind === 'hook' ? 9 : 20)] })),
    })
    expect(ScriptSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a beat longer than thirty seconds', () => {
    const bad = script({
      sections: SECTION_KINDS.map((kind) => ({ kind, beats: [beat(kind === 'hook' ? 45 : 20)] })),
    })
    expect(ScriptSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a missing section', () => {
    const bad = script({
      sections: SECTION_KINDS.slice(0, 7).map((kind) => ({ kind, beats: [beat(20)] })),
    })
    expect(ScriptSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects sections out of arc order', () => {
    const reordered = [...SECTION_KINDS].reverse()
    const bad = script({ sections: reordered.map((kind) => ({ kind, beats: [beat(20)] })) })
    expect(ScriptSchema.safeParse(bad).success).toBe(false)
  })

  it('allows many beats per section so long-form is expressible', () => {
    const long = script({
      sections: SECTION_KINDS.map((kind) => ({
        kind,
        beats: Array.from({ length: 3 }, (_, i) => ({ ...beat(25), id: `${kind}-${i}` })),
      })),
    })
    const parsed = ScriptSchema.safeParse(long)
    expect(parsed.success).toBe(true)
    const total = long.sections.flatMap((s) => s.beats).reduce((a, b) => a + b.targetSeconds, 0)
    expect(total).toBeGreaterThan(480)
  })
})

describe('ScenePlanSchema', () => {
  const scene = (visual: unknown) => ({
    id: 's1',
    beatId: 'b1',
    text: 'Narration line.',
    visual,
    camera: 'zoom-in',
  })

  it('accepts an sd-image scene with a prompt', () => {
    const result = ScenePlanSchema.safeParse({
      scenes: [scene({ kind: 'sd-image', prompt: 'a cracked desert under a red sky' })],
    })
    expect(result.success).toBe(true)
  })

  it('requires a veo-clip scene to carry an image fallback', () => {
    const missingFallback = ScenePlanSchema.safeParse({
      scenes: [scene({ kind: 'veo-clip', prompt: 'dust storm rolling in', referenceSceneId: 's1' })],
    })
    expect(missingFallback.success).toBe(false)

    const withFallback = ScenePlanSchema.safeParse({
      scenes: [
        scene({
          kind: 'veo-clip',
          prompt: 'dust storm rolling in',
          referenceSceneId: 's1',
          fallbackPrompt: 'a dust storm over a desert plain',
        }),
      ],
    })
    expect(withFallback.success).toBe(true)
  })

  it('rejects an unknown camera move', () => {
    const result = ScenePlanSchema.safeParse({
      scenes: [{ ...scene({ kind: 'sd-image', prompt: 'x' }), camera: 'barrel-roll' }],
    })
    expect(result.success).toBe(false)
  })
})

describe('SeoSchema', () => {
  const titles = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      title: `Title number ${i}`,
      scores: { curiosity: 7, searchIntent: 6, simplicity: 8, ctr: 7 },
      total: 28,
    }))

  const seo = (overrides: Record<string, unknown> = {}) => ({
    titles: titles(20),
    chosenTitle: 'Title number 0',
    description: 'A description.',
    tags: ['space', 'venus'],
    hashtags: ['#space'],
    ...overrides,
  })

  it('accepts twenty scored titles', () => {
    expect(SeoSchema.safeParse(seo()).success).toBe(true)
  })

  it('rejects fewer than twenty titles', () => {
    expect(SeoSchema.safeParse(seo({ titles: titles(5) })).success).toBe(false)
  })

  it('rejects a chosen title absent from the candidates', () => {
    expect(SeoSchema.safeParse(seo({ chosenTitle: 'Not in the list' })).success).toBe(false)
  })

  it('rejects a title over one hundred characters', () => {
    const overlong = titles(20)
    overlong[0] = { ...overlong[0]!, title: 'x'.repeat(101) }
    expect(SeoSchema.safeParse(seo({ titles: overlong, chosenTitle: 'x'.repeat(101) })).success).toBe(
      false,
    )
  })

  it('rejects tags exceeding five hundred characters in total', () => {
    const fat = Array.from({ length: 30 }, () => 'x'.repeat(20))
    expect(SeoSchema.safeParse(seo({ tags: fat })).success).toBe(false)
  })

  it('rejects a description over five thousand characters', () => {
    expect(SeoSchema.safeParse(seo({ description: 'x'.repeat(5001) })).success).toBe(false)
  })
})

describe('TopicSchema', () => {
  const topic = (overrides: Record<string, unknown> = {}) => ({
    key: 'venus-retrograde-rotation',
    title: 'Why Venus rotates backwards',
    source: 'wikipedia-top',
    url: 'https://en.wikipedia.org/wiki/Venus',
    angle: 'Follow the single measurement that overturned the assumption.',
    scores: { curiosity: 8, explainability: 7, visualPotential: 6, evergreen: 9 },
    total: 30,
    ...overrides,
  })

  it('accepts a well-formed selected topic', () => {
    expect(TopicSchema.safeParse(topic()).success).toBe(true)
  })

  it('allows a null url, since not every trend source has one', () => {
    expect(TopicSchema.safeParse(topic({ url: null })).success).toBe(true)
  })

  it('rejects a source that is not a known trend source', () => {
    expect(TopicSchema.safeParse(topic({ source: 'tiktok' })).success).toBe(false)
  })

  it('rejects a score outside 0-10', () => {
    const bad = topic({ scores: { curiosity: 11, explainability: 7, visualPotential: 6, evergreen: 9 } })
    expect(TopicSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects an empty key, because the key is the permanent dedupe identity', () => {
    expect(TopicSchema.safeParse(topic({ key: '' })).success).toBe(false)
  })
})
