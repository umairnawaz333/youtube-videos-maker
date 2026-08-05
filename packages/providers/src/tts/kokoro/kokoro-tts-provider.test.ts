import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createKokoroTtsProvider, DEFAULT_KOKORO_VOICE_MAP } from './kokoro-tts-provider'
import type { ProcessRunner } from '../../process-runner'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-kokoro-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** A minimal valid mono PCM16 wav of the given duration, matching what speak.py really writes. */
const writeTestWav = async (outPath: string, durationSec: number) => {
  const sampleRate = 16000
  const bytesPerSample = 2
  const dataBytes = Math.round(sampleRate * bytesPerSample * durationSec)
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * bytesPerSample, 28)
  buf.writeUInt16LE(bytesPerSample, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  await fs.writeFile(outPath, buf)
}

const stubRunner = (opts: {
  durationSec?: number
  onRun?: (command: string, args: string[]) => void
  fail?: string
}): ProcessRunner => ({
  async run(command, args) {
    opts.onRun?.(command, args)
    if (opts.fail) throw new Error(opts.fail)
    const outIdx = args.indexOf('--out')
    const outPath = args[outIdx + 1]!
    await writeTestWav(outPath, opts.durationSec ?? 1.2)
    return { stdout: '', stderr: '' }
  },
})

describe('createKokoroTtsProvider', () => {
  it('invokes python with the model/voices/voice/text/out arguments and returns the measured duration', async () => {
    const calls: { command: string; args: string[] }[] = []
    const provider = createKokoroTtsProvider({
      modelPath: '/models/tts/kokoro-v1.0.onnx',
      voicesPath: '/models/tts/voices-v1.0.bin',
      pythonBin: '/venv/bin/python3',
      scriptPath: '/providers/tts/kokoro/speak.py',
      runner: stubRunner({ durationSec: 2.5, onRun: (command, args) => calls.push({ command, args }) }),
    })

    const outPath = path.join(dir, 'scene-001.wav')
    const result = await provider.speak({ text: 'Hello there.', voice: 'male', outPath })

    expect(result.outPath).toBe(outPath)
    expect(result.durationSec).toBeCloseTo(2.5, 1)

    expect(calls).toHaveLength(1)
    const { command, args } = calls[0]!
    expect(command).toBe('/venv/bin/python3')
    expect(args[0]).toBe('/providers/tts/kokoro/speak.py')
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('/models/tts/kokoro-v1.0.onnx')
    expect(args[args.indexOf('--voices') + 1]).toBe('/models/tts/voices-v1.0.bin')
    expect(args[args.indexOf('--text') + 1]).toBe('Hello there.')
    expect(args[args.indexOf('--out') + 1]).toBe(outPath)
  })

  it("maps the generic voice hint 'male'/'female' to a concrete Kokoro voice id", async () => {
    const calls: { args: string[] }[] = []
    const provider = createKokoroTtsProvider({
      modelPath: 'm.onnx',
      voicesPath: 'v.bin',
      runner: stubRunner({ onRun: (_c, args) => calls.push({ args }) }),
    })

    await provider.speak({ text: 'hi', voice: 'female', outPath: path.join(dir, 'a.wav') })

    expect(calls[0]!.args[calls[0]!.args.indexOf('--voice') + 1]).toBe(DEFAULT_KOKORO_VOICE_MAP.female)
  })

  it('passes through a voice id that is not one of the generic hints unchanged', async () => {
    const calls: { args: string[] }[] = []
    const provider = createKokoroTtsProvider({
      modelPath: 'm.onnx',
      voicesPath: 'v.bin',
      runner: stubRunner({ onRun: (_c, args) => calls.push({ args }) }),
    })

    await provider.speak({ text: 'hi', voice: 'bf_emma', outPath: path.join(dir, 'a.wav') })

    expect(calls[0]!.args[calls[0]!.args.indexOf('--voice') + 1]).toBe('bf_emma')
  })

  it('rejects empty narration text before ever spawning python', async () => {
    const calls: unknown[] = []
    const provider = createKokoroTtsProvider({
      modelPath: 'm.onnx',
      voicesPath: 'v.bin',
      runner: stubRunner({ onRun: () => calls.push(1) }),
    })

    await expect(
      provider.speak({ text: '   ', voice: 'male', outPath: path.join(dir, 'a.wav') }),
    ).rejects.toThrow(/empty/)
    expect(calls).toHaveLength(0)
  })

  it('propagates a failure from the synthesis subprocess', async () => {
    const provider = createKokoroTtsProvider({
      modelPath: 'm.onnx',
      voicesPath: 'v.bin',
      runner: stubRunner({ fail: 'python exited with code 1' }),
    })

    await expect(
      provider.speak({ text: 'hi', voice: 'male', outPath: path.join(dir, 'a.wav') }),
    ).rejects.toThrow(/python exited with code 1/)
  })

  it('rejects a zero-length result instead of silently reporting a zero duration', async () => {
    const provider = createKokoroTtsProvider({
      modelPath: 'm.onnx',
      voicesPath: 'v.bin',
      runner: stubRunner({ durationSec: 0 }),
    })

    await expect(
      provider.speak({ text: 'hi', voice: 'male', outPath: path.join(dir, 'a.wav') }),
    ).rejects.toThrow(/duration/)
  })

  it('creates the output directory before invoking python', async () => {
    const provider = createKokoroTtsProvider({
      modelPath: 'm.onnx',
      voicesPath: 'v.bin',
      runner: stubRunner({}),
    })
    const outPath = path.join(dir, 'nested', 'deeper', 'scene-002.wav')

    await provider.speak({ text: 'hi', voice: 'male', outPath })

    expect((await fs.stat(path.dirname(outPath))).isDirectory()).toBe(true)
  })
})
