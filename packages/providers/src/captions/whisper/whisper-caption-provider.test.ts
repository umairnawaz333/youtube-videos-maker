import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWhisperCliCaptionProvider } from './whisper-caption-provider'
import type { ProcessRunner } from '../../process-runner'

let dir: string
let audioPath: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-whisper-'))
  audioPath = path.join(dir, 'scene-001.wav')
  await fs.writeFile(audioPath, Buffer.from('not real audio, never read by the stub'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** Matches whisper.cpp's real `-oj` output shape: a `transcription` array of entries, each
 * with millisecond `offsets` and a `text` field that commonly carries a leading space. */
const wordEntry = (text: string, fromMs: number, toMs: number) => ({
  timestamps: { from: '00:00:00,000', to: '00:00:00,000' },
  offsets: { from: fromMs, to: toMs },
  text,
})

const stubRunner = (opts: {
  transcription?: unknown[]
  onRun?: (command: string, args: string[]) => void
  fail?: string
  writeMalformed?: boolean
}): ProcessRunner => ({
  async run(command, args) {
    opts.onRun?.(command, args)
    if (opts.fail) throw new Error(opts.fail)
    const ofIdx = args.indexOf('-of')
    const outBase = args[ofIdx + 1]!
    const body = opts.writeMalformed
      ? '{not json'
      : JSON.stringify({
          systeminfo: 'fake',
          result: { language: 'en' },
          transcription: opts.transcription ?? [],
        })
    await fs.writeFile(`${outBase}.json`, body, 'utf8')
    return { stdout: '', stderr: '' }
  },
})

describe('createWhisperCliCaptionProvider', () => {
  it('runs whisper-cli word-level (-ml 1 -sow) and returns CaptionWords with seconds', async () => {
    const calls: { command: string; args: string[] }[] = []
    const provider = createWhisperCliCaptionProvider({
      modelPath: '/models/whisper/ggml-base.en.bin',
      binPath: '/opt/homebrew/bin/whisper-cli',
      runner: stubRunner({
        transcription: [wordEntry(' Hello', 0, 400), wordEntry(' world', 400, 900)],
        onRun: (command, args) => calls.push({ command, args }),
      }),
    })

    const words = await provider.transcribe(audioPath)

    expect(words).toEqual([
      { word: 'Hello', startSec: 0, endSec: 0.4 },
      { word: 'world', startSec: 0.4, endSec: 0.9 },
    ])

    const { command, args } = calls[0]!
    expect(command).toBe('/opt/homebrew/bin/whisper-cli')
    expect(args).toContain('-ml')
    expect(args[args.indexOf('-ml') + 1]).toBe('1')
    expect(args).toContain('-sow')
    expect(args).toContain('-oj')
    expect(args[args.indexOf('-m') + 1]).toBe('/models/whisper/ggml-base.en.bin')
    expect(args[args.indexOf('-f') + 1]).toBe(audioPath)
  })

  it('defaults the language to en and binPath to whisper-cli on PATH', async () => {
    const calls: { args: string[] }[] = []
    const provider = createWhisperCliCaptionProvider({
      modelPath: 'm.bin',
      runner: stubRunner({ transcription: [], onRun: (_c, args) => calls.push({ args }) }),
    })

    await provider.transcribe(audioPath)

    expect(calls[0]!.args[calls[0]!.args.indexOf('-l') + 1]).toBe('en')
  })

  it('drops blank/whitespace-only transcription entries', async () => {
    const provider = createWhisperCliCaptionProvider({
      modelPath: 'm.bin',
      runner: stubRunner({
        transcription: [wordEntry(' Hello', 0, 400), wordEntry('   ', 400, 500), wordEntry(' world', 500, 900)],
      }),
    })

    const words = await provider.transcribe(audioPath)

    expect(words.map((w) => w.word)).toEqual(['Hello', 'world'])
  })

  it('returns an empty array for a scene whisper transcribed as silence', async () => {
    const provider = createWhisperCliCaptionProvider({
      modelPath: 'm.bin',
      runner: stubRunner({ transcription: [] }),
    })

    await expect(provider.transcribe(audioPath)).resolves.toEqual([])
  })

  it('propagates a failure from the whisper-cli subprocess', async () => {
    const provider = createWhisperCliCaptionProvider({
      modelPath: 'm.bin',
      runner: stubRunner({ fail: 'whisper-cli: model file not found' }),
    })

    await expect(provider.transcribe(audioPath)).rejects.toThrow(/model file not found/)
  })

  it('raises a clear error when whisper-cli writes unparsable JSON', async () => {
    const provider = createWhisperCliCaptionProvider({
      modelPath: 'm.bin',
      runner: stubRunner({ writeMalformed: true }),
    })

    await expect(provider.transcribe(audioPath)).rejects.toThrow(/json/i)
  })

  it('cleans up its temporary working directory after a successful run', async () => {
    let capturedOutBase = ''
    const provider = createWhisperCliCaptionProvider({
      modelPath: 'm.bin',
      runner: stubRunner({
        transcription: [],
        onRun: (_c, args) => {
          capturedOutBase = args[args.indexOf('-of') + 1]!
        },
      }),
    })

    await provider.transcribe(audioPath)

    await expect(fs.access(path.dirname(capturedOutBase))).rejects.toThrow()
  })
})
