import fs from 'node:fs/promises'
import path from 'node:path'
import type { RunPaths } from '@yt/core'

/** One self-contained, hand-inspectable directory per run. See spec section 3. */
export const runPaths = (storageRoot: string, runId: string): RunPaths => {
  const root = path.resolve(storageRoot, 'videos', runId)
  return {
    root,
    audio: path.join(root, 'audio'),
    images: path.join(root, 'images'),
    clipsInbox: path.join(root, 'clips', 'inbox'),
    clipsNormalised: path.join(root, 'clips', 'normalised'),
    captions: path.join(root, 'captions'),
    thumbnail: path.join(root, 'thumbnail'),
    out: path.join(root, 'out'),
  }
}

export const ensureRunDirs = async (paths: RunPaths): Promise<void> => {
  for (const dir of [
    paths.root,
    paths.audio,
    paths.images,
    paths.clipsInbox,
    paths.clipsNormalised,
    paths.captions,
    paths.thumbnail,
    paths.out,
  ]) {
    await fs.mkdir(dir, { recursive: true })
  }
}
