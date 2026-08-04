import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createFakeProviders, FixedClock } from '@yt/providers'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-fake-'))
})

describe('fake providers', () => {
  it('writes a real decodable WAV and reports its duration', async () => {
    const p = createFakeProviders()
    const out = path.join(dir, 'a.wav')
    const result = await p.tts.speak({ text: 'Hello there world', voice: 'male', outPath: out })

    expect(result.outPath).toBe(out)
    expect(result.durationSec).toBeGreaterThan(0)
    const stat = await fs.stat(out)
    expect(stat.size).toBeGreaterThan(44)
    const header = await fs.readFile(out)
    expect(header.subarray(0, 4).toString('ascii')).toBe('RIFF')
  })

  it('derives duration from word count so scene timing is deterministic', async () => {
    const p = createFakeProviders()
    const short = await p.tts.speak({ text: 'one two', voice: 'male', outPath: path.join(dir, 's.wav') })
    const long = await p.tts.speak({
      text: 'one two three four five six seven eight',
      voice: 'male',
      outPath: path.join(dir, 'l.wav'),
    })
    expect(long.durationSec).toBeGreaterThan(short.durationSec)
  })

  it('writes a real PNG file', async () => {
    const p = createFakeProviders()
    const out = path.join(dir, 'a.png')
    await p.image.generate({ prompt: 'x', width: 64, height: 64, seed: 1, outPath: out })
    const bytes = await fs.readFile(out)
    expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG')
  })

  it('records image requests for assertions', async () => {
    const p = createFakeProviders()
    await p.image.generate({ prompt: 'a cat', width: 8, height: 8, seed: 7, outPath: path.join(dir, 'c.png') })
    expect(p.calls.images).toHaveLength(1)
    expect(p.calls.images[0]).toMatchObject({ prompt: 'a cat', seed: 7 })
  })

  it('returns word-level captions covering the audio', async () => {
    const p = createFakeProviders()
    const out = path.join(dir, 'a.wav')
    await p.tts.speak({ text: 'alpha beta gamma', voice: 'male', outPath: out })
    const words = await p.caption.transcribe(out)
    expect(words.map((w) => w.word)).toEqual(['alpha', 'beta', 'gamma'])
    expect(words[0]!.startSec).toBe(0)
    expect(words[2]!.endSec).toBeGreaterThan(words[0]!.endSec)
  })

  it('pauses on manual clip requests and collects nothing until files appear', async () => {
    const p = createFakeProviders()
    const specs = [
      { sceneId: 's1', prompt: 'p', referenceImagePath: null, targetSeconds: 6, aspectRatio: '9:16' as const },
    ]
    await expect(p.clip.request(specs)).resolves.toEqual({ status: 'paused' })
    await expect(p.clip.collect(specs)).resolves.toEqual([{ sceneId: 's1', path: null }])
  })

  it('records publishes instead of performing them', async () => {
    const p = createFakeProviders()
    const result = await p.publish.publish({
      videoPath: 'v.mp4',
      thumbnailPath: 't.png',
      captionsPath: 'c.srt',
      title: 'T',
      description: 'D',
      tags: ['a'],
      privacy: 'private',
    })
    expect(result.videoId).toMatch(/^fake-/)
    expect(p.calls.published).toHaveLength(1)
  })

  it('returns deterministic trend candidates per source', async () => {
    const p = createFakeProviders()
    const first = await p.trend.fetchCandidates(['wikipedia-top'])
    const second = await p.trend.fetchCandidates(['wikipedia-top'])
    expect(first).toEqual(second)
    expect(first.length).toBeGreaterThan(0)
  })

  it('parses JSON through the caller supplied parser', async () => {
    const p = createFakeProviders()
    const value = await p.llm.json('prompt', 'Thing', (raw) => raw as { ok: boolean })
    expect(value).toEqual({ ok: true })
  })
})

describe('FixedClock', () => {
  it('does not move unless advanced', () => {
    const clock = new FixedClock('2026-08-01T12:00:00.000Z')
    expect(clock.now().toISOString()).toBe('2026-08-01T12:00:00.000Z')
    expect(clock.now().toISOString()).toBe('2026-08-01T12:00:00.000Z')
    clock.advance(3600_000)
    expect(clock.now().toISOString()).toBe('2026-08-01T13:00:00.000Z')
  })
})
