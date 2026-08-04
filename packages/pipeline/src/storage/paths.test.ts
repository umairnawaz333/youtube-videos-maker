import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { ensureRunDirs, runPaths } from '@yt/pipeline'

describe('runPaths', () => {
  it('lays out one self-contained directory per run', () => {
    const p = runPaths('/storage', 'run-1')
    expect(p.root).toBe(path.join('/storage', 'videos', 'run-1'))
    expect(p.audio).toBe(path.join(p.root, 'audio'))
    expect(p.images).toBe(path.join(p.root, 'images'))
    expect(p.clipsInbox).toBe(path.join(p.root, 'clips', 'inbox'))
    expect(p.clipsNormalised).toBe(path.join(p.root, 'clips', 'normalised'))
    expect(p.captions).toBe(path.join(p.root, 'captions'))
    expect(p.thumbnail).toBe(path.join(p.root, 'thumbnail'))
    expect(p.out).toBe(path.join(p.root, 'out'))
  })

  it('produces absolute paths from a relative storage root', () => {
    expect(path.isAbsolute(runPaths('./storage', 'run-1').root)).toBe(true)
  })

  it('creates every directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-paths-'))
    const p = runPaths(dir, 'run-1')
    await ensureRunDirs(p)

    for (const target of [p.audio, p.images, p.clipsInbox, p.clipsNormalised, p.captions, p.thumbnail, p.out]) {
      expect((await fs.stat(target)).isDirectory()).toBe(true)
    }
  })
})
