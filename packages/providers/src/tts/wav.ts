import fs from 'node:fs/promises'

/**
 * Measures a WAV file's real duration from its own header rather than trusting whatever the
 * synthesizer claims — this is the "measured, not estimated" guarantee the narrator stage
 * exists to provide. Deliberately dependency-free (no ffprobe subprocess): kokoro-onnx (via
 * `soundfile`) always writes a standard RIFF/WAVE PCM file, so parsing the `fmt ` and `data`
 * chunks ourselves is both sufficient and exactly as accurate as shelling out would be, while
 * staying trivially unit-testable with a hand-built buffer.
 */
const readWavFormat = (buf: Buffer): { byteRate: number; dataBytes: number } => {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }

  let offset = 12
  let byteRate: number | null = null
  let dataBytes: number | null = null

  // Chunks are word-aligned and can appear in any order (LIST/fact/etc. commonly precede
  // `data`), so walk them generically rather than assuming `fmt ` and `data` are chunks 1 and 2.
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4)
    const chunkSize = buf.readUInt32LE(offset + 4)
    const body = offset + 8

    if (chunkId === 'fmt ') {
      if (body + 12 > buf.length) throw new Error('wav file has a truncated fmt chunk')
      byteRate = buf.readUInt32LE(body + 8)
    } else if (chunkId === 'data') {
      // A file truncated mid-write (e.g. a killed synthesis process) can claim a data size
      // larger than what is actually on disk; clamp to what we really have rather than
      // reading past the buffer.
      dataBytes = Math.min(chunkSize, buf.length - body)
    }

    offset = body + chunkSize + (chunkSize % 2)
  }

  if (byteRate === null) throw new Error('wav file has no fmt chunk')
  if (dataBytes === null) throw new Error('wav file has no data chunk')
  return { byteRate, dataBytes }
}

export const wavDurationSecFromBuffer = (buf: Buffer): number => {
  const { byteRate, dataBytes } = readWavFormat(buf)
  if (byteRate <= 0) throw new Error('wav file reports a zero byte rate')
  return dataBytes / byteRate
}

export const readWavDurationSec = async (filePath: string): Promise<number> => {
  const buf = await fs.readFile(filePath)
  return wavDurationSecFromBuffer(buf)
}
