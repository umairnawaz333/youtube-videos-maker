import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  CaptionProvider,
  CaptionWord,
  ClipProvider,
  ClipRequestSpec,
  Clock,
  ImageProvider,
  ImageRequest,
  LlmProvider,
  ProviderBundle,
  PublishProvider,
  PublishRequest,
  ResearchProvider,
  TopicCandidate,
  TrendProvider,
  TtsProvider,
  TtsSpeakRequest,
} from '@yt/core'

/** Deterministic stand-in for wall-clock time. */
export class FixedClock implements Clock {
  private current: number

  constructor(iso: string) {
    this.current = new Date(iso).getTime()
  }

  now(): Date {
    return new Date(this.current)
  }

  advance(ms: number): void {
    this.current += ms
  }
}

export interface FakeCallLog {
  published: PublishRequest[]
  images: ImageRequest[]
  spoken: TtsSpeakRequest[]
}

/** Seconds of speech the fake attributes to each word. Keeps scene timing predictable. */
const SECONDS_PER_WORD = 0.5

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean)

/** A minimal but genuinely decodable 8-bit mono PCM WAV of the requested duration. */
const writeWav = async (outPath: string, durationSec: number) => {
  const sampleRate = 8000
  const samples = Math.max(1, Math.round(sampleRate * durationSec))
  const buffer = Buffer.alloc(44 + samples)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + samples, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate, 28)
  buffer.writeUInt16LE(1, 32)
  buffer.writeUInt16LE(8, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(samples, 40)
  buffer.fill(128, 44) // silence at 8-bit midpoint
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  await fs.writeFile(outPath, buffer)
}

/** A 1x1 opaque PNG. Real bytes, so ffprobe and image loaders accept it. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64',
)

export const createFakeProviders = (
  opts: { seed?: number } = {},
): ProviderBundle & { calls: FakeCallLog } => {
  const calls: FakeCallLog = { published: [], images: [], spoken: [] }
  const durations = new Map<string, { durationSec: number; text: string }>()
  let publishCounter = 0

  const llm: LlmProvider = {
    async complete(prompt) {
      return `fake completion for: ${prompt.slice(0, 40)}`
    },
    async json<T>(
      _prompt: string,
      _schemaName: string,
      parse: (raw: unknown) => T,
      _opts?: { temperature?: number; maxTokens?: number },
    ): Promise<T> {
      return parse({ ok: true })
    },
    async unload() {},
  }

  const tts: TtsProvider = {
    async speak(req) {
      calls.spoken.push(req)
      const durationSec = Math.max(0.5, words(req.text).length * SECONDS_PER_WORD)
      await writeWav(req.outPath, durationSec)
      durations.set(req.outPath, { durationSec, text: req.text })
      return { outPath: req.outPath, durationSec }
    },
  }

  const image: ImageProvider = {
    async generate(req) {
      calls.images.push(req)
      await fs.mkdir(path.dirname(req.outPath), { recursive: true })
      await fs.writeFile(req.outPath, PNG_1PX)
      return { outPath: req.outPath }
    },
    async unload() {},
  }

  const clip: ClipProvider = {
    async request() {
      // Mirrors the manual adapter: the human must act, so the run pauses.
      return { status: 'paused' }
    },
    async collect(specs: ClipRequestSpec[]) {
      return specs.map((s) => ({ sceneId: s.sceneId, path: null }))
    },
  }

  const caption: CaptionProvider = {
    async transcribe(audioPath) {
      const entry = durations.get(audioPath)
      if (!entry) return []
      const list = words(entry.text)
      const per = entry.durationSec / list.length
      return list.map<CaptionWord>((word, i) => ({
        word,
        startSec: Number((i * per).toFixed(3)),
        endSec: Number(((i + 1) * per).toFixed(3)),
      }))
    },
  }

  const publish: PublishProvider = {
    async publish(req) {
      calls.published.push(req)
      publishCounter += 1
      return { videoId: `fake-${opts.seed ?? 0}-${publishCounter}` }
    },
  }

  const trend: TrendProvider = {
    async fetchCandidates(sources) {
      return sources.flatMap<TopicCandidate>((source, si) =>
        Array.from({ length: 3 }, (_, i) => ({
          key: `${source}-${si}-${i}`,
          title: `Fake candidate ${i} from ${source}`,
          source,
          url: `https://example.invalid/${source}/${i}`,
        })),
      )
    },
  }

  const research: ResearchProvider = {
    async lookup(query, opts) {
      const count = opts?.maxFacts ?? 5
      return Array.from({ length: count }, (_, i) => ({
        text: `Fake fact ${i + 1} about ${query}.`,
        sourceUrl: `https://example.invalid/${encodeURIComponent(query)}#${i + 1}`,
      }))
    },
    // Empty by default rather than fabricating a plausible source-article page: a fake source
    // that always "succeeds" would hide the fallback path this exists to exercise. Tests that
    // need to prove the researcher stage consumes source-article facts override this directly.
    async lookupSource() {
      return []
    },
  }

  return { llm, tts, image, clip, caption, publish, trend, research, calls }
}
