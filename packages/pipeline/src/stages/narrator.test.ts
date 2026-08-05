import fs from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ScenePlanSchema, type Scene } from '@yt/core'
import { createNarratorStage, sceneAudioPath } from './narrator'
import { makeStageContext, type StageHarness } from '../../../../test/fixtures/stage-context'

let h: StageHarness

const sceneFor = (id: string, text: string): Scene => ({
  id,
  beatId: `${id}-beat`,
  text,
  visual: { kind: 'sd-image', prompt: `An image for ${id}` },
  camera: 'zoom-in',
})

beforeEach(async () => {
  h = await makeStageContext({ videoType: 'long' })
})
afterEach(async () => {
  await h.cleanup()
})

describe('createNarratorStage', () => {
  it('writes one measured wav per scene and populates durationSec in scenes.json', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: [sceneFor('scene-1', 'Hello there world.'), sceneFor('scene-2', 'A much longer piece of narration text here.')],
    })

    const outcome = await createNarratorStage().run(h.ctx)

    expect(outcome).toEqual({ status: 'done' })

    const plan = await h.ctx.artifacts.read('scenes', ScenePlanSchema)
    expect(plan.scenes).toHaveLength(2)
    for (const scene of plan.scenes) {
      expect(scene.durationSec).toBeGreaterThan(0)
    }
    // The fake TTS attributes 0.5s/word: 3 words vs 8 words.
    expect(plan.scenes[0]!.durationSec).toBeCloseTo(1.5, 5)
    expect(plan.scenes[1]!.durationSec).toBeCloseTo(4, 5)
  })

  it('preserves every other scene field untouched', async () => {
    const scene = sceneFor('scene-1', 'Hello there.')
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, { scenes: [scene] })

    await createNarratorStage().run(h.ctx)

    const plan = await h.ctx.artifacts.read('scenes', ScenePlanSchema)
    expect(plan.scenes[0]).toMatchObject({
      id: scene.id,
      beatId: scene.beatId,
      text: scene.text,
      visual: scene.visual,
      camera: scene.camera,
    })
  })

  it('writes audio files at audio/scene-NNN.wav, one-indexed by position', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: [sceneFor('scene-a', 'One.'), sceneFor('scene-b', 'Two.')],
    })

    await createNarratorStage().run(h.ctx)

    const first = sceneAudioPath(h.ctx.paths, 1)
    const second = sceneAudioPath(h.ctx.paths, 2)
    expect(first.endsWith('scene-001.wav')).toBe(true)
    expect(second.endsWith('scene-002.wav')).toBe(true)
    await expect(fs.access(first)).resolves.toBeUndefined()
    await expect(fs.access(second)).resolves.toBeUndefined()
  })

  it('speaks with the resolved config voice, not the raw niche default', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, { scenes: [sceneFor('scene-1', 'Hi.')] })
    h.ctx.config.voice = 'female'
    const seenVoices: string[] = []
    const originalSpeak = h.ctx.providers.tts.speak.bind(h.ctx.providers.tts)
    h.ctx.providers.tts.speak = async (req) => {
      seenVoices.push(req.voice)
      return originalSpeak(req)
    }

    await createNarratorStage().run(h.ctx)

    expect(seenVoices).toEqual(['female'])
  })

  it('throws and leaves scenes.json unmodified when a measured duration is unusable', async () => {
    const scene = sceneFor('scene-1', 'Hi.')
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, { scenes: [scene] })
    h.providers.tts.speak = async (req) => ({ outPath: req.outPath, durationSec: 0 })

    await expect(createNarratorStage().run(h.ctx)).rejects.toThrow(/duration/)

    const plan = await h.ctx.artifacts.read('scenes', ScenePlanSchema)
    expect(plan.scenes[0]!.durationSec).toBeUndefined()
  })

  it('logs the total measured duration across all scenes', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: [sceneFor('scene-1', 'Hi there.'), sceneFor('scene-2', 'Hi there again.')],
    })

    await createNarratorStage().run(h.ctx)

    expect(h.logs.some((l) => l.message.includes('narrated 2 scenes'))).toBe(true)
  })
})
