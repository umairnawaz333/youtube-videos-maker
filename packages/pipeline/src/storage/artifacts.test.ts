import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ensureRunDirs, FileArtifactStore, runPaths } from '@yt/pipeline'

const Schema = z.object({ topicTitle: z.string(), count: z.number() })

let store: FileArtifactStore
let root: string

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-art-'))
  const paths = runPaths(dir, 'run-1')
  await ensureRunDirs(paths)
  root = paths.root
  store = new FileArtifactStore(paths)
})

describe('FileArtifactStore', () => {
  it('round-trips an artifact', async () => {
    await store.write('research', Schema, { topicTitle: 'Venus', count: 3 })
    expect(await store.read('research', Schema)).toEqual({ topicTitle: 'Venus', count: 3 })
  })

  it('writes human-readable JSON so a run can be inspected by hand', async () => {
    await store.write('research', Schema, { topicTitle: 'Venus', count: 3 })
    const raw = await fs.readFile(path.join(root, 'research.json'), 'utf8')
    expect(raw).toContain('\n  "topicTitle"')
  })

  it('reports existence without reading', async () => {
    expect(await store.exists('script')).toBe(false)
    await store.write('script', Schema, { topicTitle: 'Venus', count: 1 })
    expect(await store.exists('script')).toBe(true)
  })

  it('refuses to write data that violates the schema', async () => {
    await expect(
      store.write('research', Schema, { topicTitle: 'Venus', count: 'three' } as never),
    ).rejects.toThrow(/artifact 'research' failed validation/)
  })

  it('fails loudly when reading a file that violates the schema', async () => {
    await fs.writeFile(path.join(root, 'seo.json'), JSON.stringify({ topicTitle: 'x' }))
    await expect(store.read('seo', Schema)).rejects.toThrow(/artifact 'seo' failed validation/)
  })

  it('fails clearly when the artifact is absent', async () => {
    await expect(store.read('videoSpec', Schema)).rejects.toThrow(/artifact 'videoSpec' not found/)
  })
})
