import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ScenePlanSchema, ScriptSchema, SECTION_KINDS, type RunContext } from '@yt/core'
import { buildScenePlanPrompt, createScenePlannerStage } from '@yt/pipeline'
import { makeStageContext, type StageHarness } from '../../../../test/fixtures/stage-context'

let h: StageHarness

const scriptWith = (beatsPerSection: number) => ({
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

const sceneFor = (beatId: string, visual: unknown) => ({
  id: `scene-${beatId}`,
  beatId,
  text: `Narration for ${beatId}.`,
  visual,
  camera: 'zoom-in' as const,
})

beforeEach(async () => {
  h = await makeStageContext({ videoType: 'shorts' })
  await h.ctx.artifacts.write('script', ScriptSchema, scriptWith(1))
})
afterEach(async () => {
  await h.cleanup()
})

describe('buildScenePlanPrompt', () => {
  it('states the image and clip budgets and the niche style suffix', () => {
    const prompt = buildScenePlanPrompt({
      beats: [{ id: 'hook-0', text: 'A beat.', sectionKind: 'hook' }],
      styleSuffix: 'cinematic astrophotography',
      imageBudget: 10,
      clipBudget: 2,
      clipSections: ['hook', 'reveal'],
    })
    expect(prompt).toContain('cinematic astrophotography')
    expect(prompt).toContain('10')
    expect(prompt).toContain('2')
    expect(prompt).toContain('hook')
  })
})

describe('createScenePlannerStage', () => {
  it('writes a schema-valid scene plan', async () => {
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse({
        scenes: SECTION_KINDS.map((k) => sceneFor(`${k}-0`, { kind: 'sd-image', prompt: `An image for ${k}` })),
      })) as RunContext['providers']['llm']['json']

    await expect(createScenePlannerStage().run(h.ctx)).resolves.toEqual({ status: 'done' })

    const plan = await h.ctx.artifacts.read('scenes', ScenePlanSchema)
    expect(plan.scenes).toHaveLength(8)
  })

  it('rewrites images beyond the budget as reuse of an earlier image', async () => {
    // Use the `long` preset here: its imageBudget is 70 with maxScenes 90, so we can exceed
    // the image budget without also exceeding the scene cap (which would halt the stage
    // before it ever reached the budget logic).
    const long = await makeStageContext({ videoType: 'long', runId: 'run-budget' })
    await long.ctx.artifacts.write('script', ScriptSchema, scriptWith(10)) // 80 beats
    const allBeats = scriptWith(10).sections.flatMap((s) => s.beats.map((b) => b.id))
    long.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse({ scenes: allBeats.map((b) => sceneFor(b, { kind: 'sd-image', prompt: `Image ${b}` })) })) as RunContext['providers']['llm']['json']

    await createScenePlannerStage().run(long.ctx)

    const plan = await long.ctx.artifacts.read('scenes', ScenePlanSchema)
    const images = plan.scenes.filter((s) => s.visual.kind === 'sd-image')
    const reuses = plan.scenes.filter((s) => s.visual.kind === 'reuse')
    expect(images.length).toBe(long.ctx.config.preset.imageBudget) // exactly the budget, 70
    expect(reuses.length).toBe(80 - long.ctx.config.preset.imageBudget) // the remaining 10
    // Every reuse must point at a scene that really exists and really holds an image.
    const imageIds = new Set(images.map((s) => s.id))
    for (const r of reuses) {
      expect(imageIds.has((r.visual as { sceneId: string }).sceneId)).toBe(true)
    }
    await long.cleanup()
  })

  it('gives every veo-clip a fallback prompt even when the model omitted one', async () => {
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse({
        scenes: SECTION_KINDS.map((k, i) =>
          i === 0
            // A single space: passes SceneVisualSchema's min(1) so the plan parses, but fails
            // the stage's trim check, which is what exercises the synthesis branch. An empty
            // string would be rejected by the schema before the stage ever saw it.
            ? sceneFor(`${k}-0`, { kind: 'veo-clip', prompt: 'A dust storm rolling in', referenceSceneId: 'scene-hook-0', fallbackPrompt: ' ' })
            : sceneFor(`${k}-0`, { kind: 'sd-image', prompt: `Image ${k}` }),
        ),
      })) as RunContext['providers']['llm']['json']

    await createScenePlannerStage().run(h.ctx)

    const plan = await h.ctx.artifacts.read('scenes', ScenePlanSchema)
    const clip = plan.scenes.find((s) => s.visual.kind === 'veo-clip')
    expect(clip).toBeDefined()
    expect((clip!.visual as { fallbackPrompt: string }).fallbackPrompt.length).toBeGreaterThan(0)
  })

  it('converts a veo-clip placed outside the configured sections into an image', async () => {
    // clips.placement defaults to hook, reveal, twist. 'conclusion' is not permitted.
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse({
        scenes: SECTION_KINDS.map((k) =>
          k === 'conclusion'
            ? sceneFor(`${k}-0`, { kind: 'veo-clip', prompt: 'A clip', referenceSceneId: 'scene-hook-0', fallbackPrompt: 'A fallback' })
            : sceneFor(`${k}-0`, { kind: 'sd-image', prompt: `Image ${k}` }),
        ),
      })) as RunContext['providers']['llm']['json']

    await createScenePlannerStage().run(h.ctx)

    const plan = await h.ctx.artifacts.read('scenes', ScenePlanSchema)
    const conclusion = plan.scenes.find((s) => s.beatId === 'conclusion-0')!
    expect(conclusion.visual.kind).toBe('sd-image')
  })

  it('halts when the model returns more scenes than the preset allows', async () => {
    const many = Array.from({ length: 200 }, (_, i) => sceneFor(`x-${i}`, { kind: 'sd-image', prompt: `Image ${i}` }))
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse({ scenes: many })) as RunContext['providers']['llm']['json']

    const outcome = await createScenePlannerStage().run(h.ctx)

    expect(outcome).toMatchObject({ status: 'halted' })
    expect((outcome as { reason: string }).reason).toMatch(/scene/i)
  })
})
