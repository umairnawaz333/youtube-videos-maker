import fs from 'node:fs/promises'
import path from 'node:path'
import { ScriptSchema, SeoSchema, type Script, type Seo } from '@yt/core'
import { FileArtifactStore, runPaths } from '@yt/pipeline'
import { storageRoot } from './env'

export const pathsForRun = (runId: string) => runPaths(storageRoot(), runId)

const exists = async (p: string): Promise<boolean> => {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** Null when the artifact hasn't been written yet — a still-running or early-failed run. */
export const readScript = async (runId: string): Promise<Script | null> => {
  const store = new FileArtifactStore(pathsForRun(runId))
  if (!(await store.exists('script'))) return null
  try {
    return await store.read('script', ScriptSchema)
  } catch {
    return null
  }
}

export const readSeo = async (runId: string): Promise<Seo | null> => {
  const store = new FileArtifactStore(pathsForRun(runId))
  if (!(await store.exists('seo'))) return null
  try {
    return await store.read('seo', SeoSchema)
  } catch {
    return null
  }
}

export interface ReviewAssets {
  /** Present once the Editor stage has rendered the final H.264 MP4. */
  videoPath: string | null
  /**
   * The five composited hero candidates (`thumbnail/v1.png` .. `v5.png`), in order. Empty
   * until the Editor stage burns the text overlay onto the Thumbnailer's raw heroes.
   */
  thumbnailPaths: string[]
}

const THUMBNAIL_COUNT = 5

export const readReviewAssets = async (runId: string): Promise<ReviewAssets> => {
  const paths = pathsForRun(runId)

  const videoPath = path.join(paths.out, 'video.mp4')
  const hasVideo = await exists(videoPath)

  const thumbnailPaths: string[] = []
  for (let i = 1; i <= THUMBNAIL_COUNT; i++) {
    const p = path.join(paths.thumbnail, `v${i}.png`)
    if (await exists(p)) thumbnailPaths.push(p)
  }

  return { videoPath: hasVideo ? videoPath : null, thumbnailPaths }
}

/**
 * Maps a `/media/<runId>/<kind>/<file>` request onto an actual file on disk, or `null` if it
 * doesn't match one of the two things this app ever serves. Deliberately an allowlist rather
 * than a plain `path.join` of user input — the render output and the five thumbnail
 * candidates are the only two files this route may ever return.
 */
export const resolveMediaPath = (runId: string, segments: string[]): string | null => {
  if (segments.length !== 2) return null
  const [kind, file] = segments as [string, string]
  const paths = pathsForRun(runId)

  if (kind === 'out' && file === 'video.mp4') return path.join(paths.out, file)
  if (kind === 'thumbnail' && /^v[1-5]\.png$/.test(file)) return path.join(paths.thumbnail, file)
  return null
}
