import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readWavDurationSec, wavDurationSecFromBuffer } from './wav'

/** Builds a minimal but genuinely valid PCM WAV buffer, optionally with a junk chunk
 * inserted before `data` to prove chunk-walking doesn't assume a fixed layout. */
const buildWav = (opts: {
  sampleRate: number
  channels: number
  bitsPerSample: number
  durationSec: number
  extraChunk?: { id: string; size: number }
}): Buffer => {
  const { sampleRate, channels, bitsPerSample, durationSec, extraChunk } = opts
  const blockAlign = channels * (bitsPerSample / 8)
  const byteRate = sampleRate * blockAlign
  const dataBytes = Math.round(byteRate * durationSec)

  const fmtChunk = Buffer.alloc(8 + 16)
  fmtChunk.write('fmt ', 0, 'ascii')
  fmtChunk.writeUInt32LE(16, 4)
  fmtChunk.writeUInt16LE(1, 8) // PCM
  fmtChunk.writeUInt16LE(channels, 10)
  fmtChunk.writeUInt32LE(sampleRate, 12)
  fmtChunk.writeUInt32LE(byteRate, 16)
  fmtChunk.writeUInt16LE(blockAlign, 20)
  fmtChunk.writeUInt16LE(bitsPerSample, 22)

  const junk = extraChunk
    ? (() => {
        const c = Buffer.alloc(8 + extraChunk.size + (extraChunk.size % 2))
        c.write(extraChunk.id, 0, 'ascii')
        c.writeUInt32LE(extraChunk.size, 4)
        return c
      })()
    : Buffer.alloc(0)

  const dataChunk = Buffer.alloc(8 + dataBytes)
  dataChunk.write('data', 0, 'ascii')
  dataChunk.writeUInt32LE(dataBytes, 4)
  dataChunk.fill(0, 8)

  const riffSize = 4 + fmtChunk.length + junk.length + dataChunk.length
  const header = Buffer.alloc(12)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(riffSize, 4)
  header.write('WAVE', 8, 'ascii')

  return Buffer.concat([header, fmtChunk, junk, dataChunk])
}

describe('wavDurationSecFromBuffer', () => {
  it('measures a standard mono 8-bit wav', () => {
    const buf = buildWav({ sampleRate: 8000, channels: 1, bitsPerSample: 8, durationSec: 2 })
    expect(wavDurationSecFromBuffer(buf)).toBeCloseTo(2, 5)
  })

  it('measures a stereo 16-bit wav at a different sample rate', () => {
    const buf = buildWav({ sampleRate: 24000, channels: 2, bitsPerSample: 16, durationSec: 1.5 })
    expect(wavDurationSecFromBuffer(buf)).toBeCloseTo(1.5, 5)
  })

  it('skips an unrelated chunk (e.g. LIST) placed before data', () => {
    const buf = buildWav({
      sampleRate: 22050,
      channels: 1,
      bitsPerSample: 16,
      durationSec: 3,
      extraChunk: { id: 'LIST', size: 11 }, // odd size forces the word-alignment path too
    })
    expect(wavDurationSecFromBuffer(buf)).toBeCloseTo(3, 5)
  })

  it('rejects a non-RIFF buffer', () => {
    expect(() => wavDurationSecFromBuffer(Buffer.from('not a wav at all'))).toThrow(/RIFF/)
  })

  it('rejects a RIFF buffer with no fmt chunk', () => {
    const header = Buffer.alloc(12)
    header.write('RIFF', 0, 'ascii')
    header.writeUInt32LE(4, 4)
    header.write('WAVE', 8, 'ascii')
    expect(() => wavDurationSecFromBuffer(header)).toThrow(/fmt/)
  })

  it('rejects a fmt chunk with no data chunk', () => {
    const buf = buildWav({ sampleRate: 8000, channels: 1, bitsPerSample: 8, durationSec: 1 })
    // Strip everything from the data chunk onward.
    const dataIdx = buf.indexOf('data')
    expect(() => wavDurationSecFromBuffer(buf.subarray(0, dataIdx))).toThrow(/data/)
  })

  it('clamps a data chunk whose declared size overruns the actual buffer', () => {
    const buf = buildWav({ sampleRate: 8000, channels: 1, bitsPerSample: 8, durationSec: 2 })
    const truncated = buf.subarray(0, buf.length - 4000) // chop off the last half-second
    expect(wavDurationSecFromBuffer(truncated)).toBeCloseTo(1.5, 1)
  })
})

describe('readWavDurationSec', () => {
  it('reads and measures a real file from disk', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-wav-'))
    const file = path.join(dir, 'scene-001.wav')
    await fs.writeFile(file, buildWav({ sampleRate: 16000, channels: 1, bitsPerSample: 16, durationSec: 4 }))

    await expect(readWavDurationSec(file)).resolves.toBeCloseTo(4, 5)

    await fs.rm(dir, { recursive: true, force: true })
  })
})
