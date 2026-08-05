import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * YouTube thumbnails are always 1280x720 regardless of the video's own format preset — a
 * Shorts run is still uploaded with a 16:9 thumbnail. Fixed here rather than derived from
 * the video preset so a Shorts run doesn't accidentally get a 9:16 thumbnail.
 */
export const THUMBNAIL_WIDTH = 1280
export const THUMBNAIL_HEIGHT = 720

/**
 * Finds the raw hero images the Thumbnailer stage produced (`raw-v1.png` .. `raw-vN.png`)
 * so the Editor can composite each one's text overlay into the final `v1.png` .. `vN.png`.
 * An empty result (no thumbnailer run yet, or none matched) is not an error here — the
 * Editor logs and skips; QualityGate is what enforces a thumbnail must exist by render's end.
 */
export const discoverRawThumbnails = async (thumbnailDir: string): Promise<string[]> => {
  let entries: string[]
  try {
    entries = await fs.readdir(thumbnailDir)
  } catch {
    return []
  }
  return entries
    .filter((f) => /^raw-v\d+\.png$/i.test(f))
    .sort()
    .map((f) => path.join(thumbnailDir, f))
}

/** `raw-v1.png` -> `v1.png`, in the same directory. */
export const finalThumbnailPath = (rawPath: string): string =>
  path.join(path.dirname(rawPath), path.basename(rawPath).replace(/^raw-/i, ''))
