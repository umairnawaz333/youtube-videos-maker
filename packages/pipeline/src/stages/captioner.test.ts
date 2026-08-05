import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CaptionWordsFileSchema, ScenePlanSchema, type Scene } from '@yt/core'
import { buildSrt, createCaptionerStage, groupWordsIntoCues } from './captioner'
import { createNarratorStage } from './narrator'
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

describe('createCaptionerStage', () => {
  it('shifts each scene’s words by the running total of earlier scenes’ MEASURED duration', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: [
        sceneFor('scene-1', 'Hello there world.'), // 3 words -> fake tts = 1.5s
        sceneFor('scene-2', 'A much longer piece of narration text here.'), // 8 words -> 4s
      ],
    })
    await createNarratorStage().run(h.ctx)

    const outcome = await createCaptionerStage().run(h.ctx)
    expect(outcome).toEqual({ status: 'done' })

    const raw = await fs.readFile(path.join(h.ctx.paths.captions, 'words.json'), 'utf8')
    const parsed = CaptionWordsFileSchema.parse(JSON.parse(raw))

    // Scene 1: 3 words over 1.5s -> 0.5s/word, starting at global t=0.
    expect(parsed.words[0]).toEqual({ word: 'Hello', startSec: 0, endSec: 0.5 })
    expect(parsed.words[2]).toEqual({ word: 'world.', startSec: 1, endSec: 1.5 })
    // Scene 2 starts where scene 1 ended (1.5s), not at 0.
    expect(parsed.words[3]!.startSec).toBeCloseTo(1.5, 5)
    expect(parsed.words).toHaveLength(11)
  })

  it('writes a valid SRT file with sequential cue numbers and arrow timestamps', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, { scenes: [sceneFor('scene-1', 'Hello there world.')] })
    await createNarratorStage().run(h.ctx)

    await createCaptionerStage().run(h.ctx)

    const srt = await fs.readFile(path.join(h.ctx.paths.captions, 'captions.srt'), 'utf8')
    expect(srt).toMatch(/^1\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\nHello there world\.\n/)
  })

  it('throws when a scene has no measured durationSec (narrator has not run)', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, { scenes: [sceneFor('scene-1', 'Hello.')] })

    await expect(createCaptionerStage().run(h.ctx)).rejects.toThrow(/narrator/)
  })

  it('warns but still writes empty caption files when transcription yields nothing', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, { scenes: [sceneFor('scene-1', 'Hello.')] })
    await createNarratorStage().run(h.ctx)
    h.ctx.providers.caption.transcribe = async () => []

    await createCaptionerStage().run(h.ctx)

    const raw = await fs.readFile(path.join(h.ctx.paths.captions, 'words.json'), 'utf8')
    expect(CaptionWordsFileSchema.parse(JSON.parse(raw)).words).toEqual([])
    const srt = await fs.readFile(path.join(h.ctx.paths.captions, 'captions.srt'), 'utf8')
    expect(srt).toBe('')
    expect(h.logs.some((l) => l.level === 'warn')).toBe(true)
  })
})

describe('groupWordsIntoCues', () => {
  it('splits a cue at sentence-ending punctuation', () => {
    const words = [
      { word: 'Hi.', startSec: 0, endSec: 0.4 },
      { word: 'Bye.', startSec: 0.4, endSec: 0.8 },
    ]
    expect(groupWordsIntoCues(words)).toEqual([
      { text: 'Hi.', startSec: 0, endSec: 0.4 },
      { text: 'Bye.', startSec: 0.4, endSec: 0.8 },
    ])
  })

  it('caps a cue at MAX_WORDS_PER_CUE words even with no punctuation', () => {
    const words = Array.from({ length: 25 }, (_, i) => ({
      word: `w${i}`,
      startSec: i * 0.2,
      endSec: (i + 1) * 0.2,
    }))
    const cues = groupWordsIntoCues(words)
    expect(cues[0]!.text.split(' ')).toHaveLength(10)
    expect(cues.every((c) => c.text.split(' ').length <= 10)).toBe(true)
  })

  it('returns no cues for an empty word list', () => {
    expect(groupWordsIntoCues([])).toEqual([])
  })
})

describe('buildSrt', () => {
  it('produces an empty string for an empty transcript', () => {
    expect(buildSrt([])).toBe('')
  })

  it('formats timestamps as HH:MM:SS,mmm', () => {
    const srt = buildSrt([{ word: 'Hi.', startSec: 61.234, endSec: 62.5 }])
    expect(srt).toContain('00:01:01,234 --> 00:01:02,500')
  })
})
