import fs from 'node:fs/promises'
import path from 'node:path'
import {
  CaptionWordsFileSchema,
  ScenePlanSchema,
  STAGE_REQUIREMENTS,
  type CaptionWordEntry,
  type Stage,
} from '@yt/core'
import { sceneAudioPath } from './narrator'

const MAX_WORDS_PER_CUE = 10
const MAX_CUE_SECONDS = 6

interface SrtCue {
  text: string
  startSec: number
  endSec: number
}

/** Groups word-level timestamps into subtitle-length lines: whichever comes first of a word
 * count cap, a duration cap, or the end of a sentence. Word-level granularity is still kept
 * verbatim in captions/words.json for Remotion's animated captions — this grouping exists only
 * for the human-readable SRT track uploaded to YouTube. */
export const groupWordsIntoCues = (words: CaptionWordEntry[]): SrtCue[] => {
  const cues: SrtCue[] = []
  let current: CaptionWordEntry[] = []

  const flush = () => {
    if (current.length === 0) return
    cues.push({
      text: current.map((w) => w.word).join(' '),
      startSec: current[0]!.startSec,
      endSec: current[current.length - 1]!.endSec,
    })
    current = []
  }

  for (const w of words) {
    current.push(w)
    const spanSec = w.endSec - current[0]!.startSec
    const endsSentence = /[.!?]$/.test(w.word)
    if (current.length >= MAX_WORDS_PER_CUE || spanSec >= MAX_CUE_SECONDS || endsSentence) {
      flush()
    }
  }
  flush()
  return cues
}

const srtTimestamp = (sec: number): string => {
  const totalMs = Math.max(0, Math.round(sec * 1000))
  const ms = totalMs % 1000
  const totalSec = Math.floor(totalMs / 1000)
  const s = totalSec % 60
  const totalMin = Math.floor(totalSec / 60)
  const m = totalMin % 60
  const h = Math.floor(totalMin / 60)
  const pad = (n: number, len = 2) => String(n).padStart(len, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`
}

/** Builds a valid SRT document. An empty word list yields an empty (still valid — zero cues)
 * document; the quality gate, not this stage, is where "captions are absent" halts a run. */
export const buildSrt = (words: CaptionWordEntry[]): string => {
  const cues = groupWordsIntoCues(words)
  return cues
    .map((cue, i) => `${i + 1}\n${srtTimestamp(cue.startSec)} --> ${srtTimestamp(cue.endSec)}\n${cue.text}\n`)
    .join('\n')
}

/**
 * Captioner: transcribes each scene's narration with word-level timestamps and writes
 * captions/words.json (global timeline, for Remotion's word-by-word captions) and
 * captions.srt (human-readable, uploaded to YouTube for search indexing).
 *
 * Each scene's WAV is transcribed independently (whisper.cpp sees timestamps starting at 0
 * for every file), so every word is shifted by the running total of every EARLIER scene's
 * MEASURED duration — not whisper's own last-word end time, which can drift slightly from the
 * true file length (trailing silence, VAD trimming) and would compound across dozens of
 * scenes. `scene.durationSec` (written by the narrator stage) is the authoritative value.
 */
export const createCaptionerStage = (): Stage => ({
  name: 'captioner',
  requires: STAGE_REQUIREMENTS.captioner,

  async run(ctx) {
    const plan = await ctx.artifacts.read('scenes', ScenePlanSchema)

    let offsetSec = 0
    const words: CaptionWordEntry[] = []

    for (const [i, scene] of plan.scenes.entries()) {
      const durationSec = scene.durationSec
      if (durationSec === undefined) {
        throw new Error(
          `captioner: scene '${scene.id}' has no measured durationSec — the narrator stage ` +
            `must run before the captioner`,
        )
      }

      const audioPath = sceneAudioPath(ctx.paths, i + 1)
      const sceneWords = await ctx.providers.caption.transcribe(audioPath)
      for (const w of sceneWords) {
        words.push({ word: w.word, startSec: offsetSec + w.startSec, endSec: offsetSec + w.endSec })
      }

      offsetSec += durationSec
    }

    if (words.length === 0) {
      ctx.log.warn('captioner produced zero words across every scene')
    }

    const wordsFile = CaptionWordsFileSchema.parse({ words })
    await fs.mkdir(ctx.paths.captions, { recursive: true })
    await fs.writeFile(
      path.join(ctx.paths.captions, 'words.json'),
      `${JSON.stringify(wordsFile, null, 2)}\n`,
      'utf8',
    )
    await fs.writeFile(path.join(ctx.paths.captions, 'captions.srt'), buildSrt(words), 'utf8')

    ctx.log.info(`captioned ${words.length} words across ${plan.scenes.length} scenes`)
    return { status: 'done' }
  },
})
