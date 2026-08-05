import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ScriptSchema, SeoSchema, type Script, type Seo } from '@yt/core'
import { ensureRunDirs, FileArtifactStore, runPaths } from '@yt/pipeline'
import { pathsForRun, readReviewAssets, readScript, readSeo, resolveMediaPath } from '../artifacts'

const sampleScript = (): Script => ({
  topicTitle: 'Why the sky is blue',
  sections: [
    { kind: 'hook', beats: [{ id: 'b1', text: 'Ever wonder why?', targetSeconds: 20 }] },
    { kind: 'question', beats: [{ id: 'b2', text: 'What causes it?', targetSeconds: 20 }] },
    { kind: 'conflict', beats: [{ id: 'b3', text: 'It seemed simple.', targetSeconds: 20 }] },
    { kind: 'curiosity', beats: [{ id: 'b4', text: 'But then...', targetSeconds: 20 }] },
    { kind: 'reveal', beats: [{ id: 'b5', text: 'Rayleigh scattering.', targetSeconds: 20 }] },
    { kind: 'twist', beats: [{ id: 'b6', text: 'Sunsets are red because...', targetSeconds: 20 }] },
    { kind: 'conclusion', beats: [{ id: 'b7', text: 'So now you know.', targetSeconds: 20 }] },
    { kind: 'cta', beats: [{ id: 'b8', text: 'Subscribe for more.', targetSeconds: 20 }] },
  ],
})

const sampleSeo = (): Seo => {
  const titles = Array.from({ length: 20 }, (_, i) => ({
    title: `Title candidate ${i + 1}`,
    scores: { curiosity: 5, searchIntent: 5, simplicity: 5, ctr: 5 },
    total: 20,
  }))
  titles[0]!.total = 30
  return {
    titles,
    chosenTitle: titles[0]!.title,
    description: 'A description.',
    tags: ['science'],
    hashtags: ['#science'],
  }
}

describe('artifacts', () => {
  let tmpRoot: string
  const runId = 'run-test-1'

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dashboard-artifacts-'))
    process.env.STORAGE_ROOT = tmpRoot
  })

  afterEach(async () => {
    delete process.env.STORAGE_ROOT
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  it('returns null for artifacts that do not exist yet', async () => {
    expect(await readScript(runId)).toBeNull()
    expect(await readSeo(runId)).toBeNull()
  })

  it('reads a written script.json back through the schema', async () => {
    const paths = runPaths(tmpRoot, runId)
    await ensureRunDirs(paths)
    await new FileArtifactStore(paths).write('script', ScriptSchema, sampleScript())

    const script = await readScript(runId)
    expect(script?.topicTitle).toBe('Why the sky is blue')
    expect(script?.sections).toHaveLength(8)
  })

  it('reads a written seo.json back through the schema', async () => {
    const paths = runPaths(tmpRoot, runId)
    await ensureRunDirs(paths)
    await new FileArtifactStore(paths).write('seo', SeoSchema, sampleSeo())

    const seo = await readSeo(runId)
    expect(seo?.titles).toHaveLength(20)
    expect(seo?.chosenTitle).toBe('Title candidate 1')
  })

  it('reports no video and no thumbnails when nothing has been rendered', async () => {
    const assets = await readReviewAssets(runId)
    expect(assets.videoPath).toBeNull()
    expect(assets.thumbnailPaths).toEqual([])
  })

  it('finds the rendered video and only the thumbnails that exist', async () => {
    const paths = pathsForRun(runId)
    await ensureRunDirs(paths)
    await fs.writeFile(path.join(paths.out, 'video.mp4'), 'fake mp4 bytes')
    await fs.writeFile(path.join(paths.thumbnail, 'v1.png'), 'fake png')
    await fs.writeFile(path.join(paths.thumbnail, 'v3.png'), 'fake png')
    // A raw, un-composited hero must never be reported as a reviewable thumbnail.
    await fs.writeFile(path.join(paths.thumbnail, 'raw-v2.png'), 'fake png')

    const assets = await readReviewAssets(runId)
    expect(assets.videoPath).toBe(path.join(paths.out, 'video.mp4'))
    expect(assets.thumbnailPaths).toEqual([path.join(paths.thumbnail, 'v1.png'), path.join(paths.thumbnail, 'v3.png')])
  })
})

describe('resolveMediaPath', () => {
  const runId = 'run-test-2'

  it('resolves the rendered video', () => {
    const resolved = resolveMediaPath(runId, ['out', 'video.mp4'])
    expect(resolved).toBe(path.join(pathsForRun(runId).out, 'video.mp4'))
  })

  it('resolves a valid thumbnail candidate', () => {
    const resolved = resolveMediaPath(runId, ['thumbnail', 'v5.png'])
    expect(resolved).toBe(path.join(pathsForRun(runId).thumbnail, 'v5.png'))
  })

  it('rejects anything not on the allowlist', () => {
    expect(resolveMediaPath(runId, ['out', 'video.mov'])).toBeNull()
    expect(resolveMediaPath(runId, ['thumbnail', 'v6.png'])).toBeNull()
    expect(resolveMediaPath(runId, ['thumbnail', 'raw-v1.png'])).toBeNull()
    expect(resolveMediaPath(runId, ['audio', 'scene-001.wav'])).toBeNull()
  })

  it('rejects path traversal attempts', () => {
    expect(resolveMediaPath(runId, ['out', '../../../etc/passwd'])).toBeNull()
    expect(resolveMediaPath(runId, ['thumbnail', '../v1.png'])).toBeNull()
  })

  it('rejects malformed segment counts', () => {
    expect(resolveMediaPath(runId, ['out'])).toBeNull()
    expect(resolveMediaPath(runId, ['out', 'video.mp4', 'extra'])).toBeNull()
  })
})
