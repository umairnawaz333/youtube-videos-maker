import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CaptionProvider, CaptionWord } from '@yt/core'
import { nodeProcessRunner, type ProcessRunner } from './process-runner'

/** The subset of whisper.cpp's `--output-json` shape this provider actually reads. Every
 * other field (systeminfo, model, params, result.language, ...) is ignored. */
interface WhisperJsonOutput {
  transcription?: Array<{
    offsets?: { from?: number; to?: number }
    text?: string
  }>
}

export interface WhisperCliCaptionProviderOptions {
  /** Absolute path to a downloaded ggml-*.bin model (see scripts/setup-whisper.sh). */
  modelPath: string
  /** Defaults to 'whisper-cli' on PATH. */
  binPath?: string
  /** Defaults to 'en' — the MVP is English-only (spec §5). */
  language?: string
  runner?: ProcessRunner
}

/**
 * Wraps the already-installed `whisper-cli` (whisper.cpp) to get WORD-level timestamps.
 * whisper.cpp's segments are phrase-length by default; `-ml 1 -sow` (max segment length 1,
 * split on word rather than token) is the standard whisper.cpp technique that forces one
 * transcription entry per word, which is what `-oj`'s per-entry `offsets.from`/`offsets.to`
 * (in milliseconds) then gives us as word boundaries.
 *
 * Each call runs whisper-cli once per audio file in its own temp directory (removed
 * afterwards) rather than a long-lived server — matches `STAGE_REQUIREMENTS.captioner: 'none'`,
 * since the ModelBroker never needs to track this process's memory.
 */
export const createWhisperCliCaptionProvider = (opts: WhisperCliCaptionProviderOptions): CaptionProvider => {
  const binPath = opts.binPath ?? 'whisper-cli'
  const language = opts.language ?? 'en'
  const runner = opts.runner ?? nodeProcessRunner()

  return {
    async transcribe(audioPath: string): Promise<CaptionWord[]> {
      const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-whisper-'))
      const outBase = path.join(workDir, 'out')

      try {
        try {
          await runner.run(binPath, [
            '-m',
            opts.modelPath,
            '-f',
            audioPath,
            '-l',
            language,
            '-ml',
            '1',
            '-sow',
            '-oj',
            '-of',
            outBase,
            '-np',
          ])
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          throw new Error(`whisper-cli failed transcribing ${audioPath}: ${detail}`)
        }

        const jsonPath = `${outBase}.json`
        let raw: string
        try {
          raw = await fs.readFile(jsonPath, 'utf8')
        } catch {
          throw new Error(
            `whisper-cli did not produce the expected output file ${jsonPath} for ${audioPath}`,
          )
        }

        let parsed: WhisperJsonOutput
        try {
          parsed = JSON.parse(raw) as WhisperJsonOutput
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          throw new Error(`whisper-cli produced invalid json at ${jsonPath}: ${detail}`)
        }

        const entries = parsed.transcription ?? []
        const words: CaptionWord[] = []
        for (const entry of entries) {
          const word = (entry.text ?? '').trim()
          if (word.length === 0) continue
          const fromMs = entry.offsets?.from ?? 0
          const toMs = entry.offsets?.to ?? fromMs
          words.push({ word, startSec: fromMs / 1000, endSec: toMs / 1000 })
        }
        return words
      } finally {
        await fs.rm(workDir, { recursive: true, force: true })
      }
    },
  }
}
