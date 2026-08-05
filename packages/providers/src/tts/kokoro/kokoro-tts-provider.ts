import fs from 'node:fs/promises'
import path from 'node:path'
import type { TtsProvider, TtsSpeakRequest, TtsSpeakResult } from '@yt/core'
import { readWavDurationSec } from '../wav'
import { nodeProcessRunner, type ProcessRunner } from '../../process-runner'

/**
 * Generic voice hints (matching `config/niches/*.json`'s `"voice": "male"` style values) are
 * resolved to a concrete Kokoro speaker id here. A `voice` that is not one of these keys is
 * assumed to already be a real Kokoro voice id (e.g. `'bf_emma'`) and passed through
 * unchanged — this is what keeps the mapping additive rather than a closed enum.
 */
export const DEFAULT_KOKORO_VOICE_MAP: Record<string, string> = {
  male: 'am_adam',
  female: 'af_sarah',
}

export interface KokoroTtsProviderOptions {
  /** Absolute path to the downloaded kokoro-v1.0*.onnx file (see scripts/setup-tts.sh). */
  modelPath: string
  /** Absolute path to the downloaded voices-v1.0.bin file. */
  voicesPath: string
  /** Defaults to 'python3' on PATH. Point this at `.venv/bin/python3` in real use. */
  pythonBin?: string
  /** Defaults to the speak.py bundled next to this file. */
  scriptPath?: string
  voiceMap?: Record<string, string>
  speed?: number
  lang?: string
  runner?: ProcessRunner
}

/**
 * Kokoro-82M via a per-call `python3 speak.py` subprocess (see that file) rather than a warm
 * sidecar server. Unlike SDXL, an 82M-parameter ONNX session is cheap enough to load fresh
 * per scene that a persistent process is not worth the added moving part for the MVP; nothing
 * about the `TtsProvider` interface below would need to change if a warm sidecar replaced this
 * later (see the SDXL sidecar for that pattern), so this is a real design choice, not a
 * shortcut baked into the interface.
 *
 * Piper (the spec's fallback TTS engine) implements the exact same `TtsProvider` — this
 * factory adds nothing Kokoro-specific to the interface itself.
 */
export const createKokoroTtsProvider = (opts: KokoroTtsProviderOptions): TtsProvider => {
  const pythonBin = opts.pythonBin ?? 'python3'
  const scriptPath = opts.scriptPath ?? path.join(__dirname, 'speak.py')
  const voiceMap = opts.voiceMap ?? DEFAULT_KOKORO_VOICE_MAP
  const speed = opts.speed ?? 1.0
  const lang = opts.lang ?? 'en-us'
  const runner = opts.runner ?? nodeProcessRunner()

  return {
    async speak(req: TtsSpeakRequest): Promise<TtsSpeakResult> {
      if (req.text.trim().length === 0) {
        throw new Error(`kokoro: cannot synthesize empty text for ${req.outPath}`)
      }

      await fs.mkdir(path.dirname(req.outPath), { recursive: true })
      const voice = voiceMap[req.voice] ?? req.voice

      await runner.run(pythonBin, [
        scriptPath,
        '--model',
        opts.modelPath,
        '--voices',
        opts.voicesPath,
        '--voice',
        voice,
        '--text',
        req.text,
        '--out',
        req.outPath,
        '--speed',
        String(speed),
        '--lang',
        lang,
      ])

      const durationSec = await readWavDurationSec(req.outPath)
      if (!(durationSec > 0)) {
        throw new Error(`kokoro: produced a non-positive measured duration (${durationSec}s) at ${req.outPath}`)
      }

      return { outPath: req.outPath, durationSec }
    },
  }
}
