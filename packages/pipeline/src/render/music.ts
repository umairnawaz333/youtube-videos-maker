import fs from 'node:fs/promises'
import path from 'node:path'

export interface MusicTrack {
  file: string
  mood: string
  license: string
  sourceUrl?: string
  attribution?: string
}

export interface MusicManifest {
  tracks: MusicTrack[]
}

/**
 * Resolves the niche's music mood (`NicheConfig.music`, e.g. `"ambient-drone"`) to an
 * absolute track path via `assets/music/manifest.json`. `assets/music/` ships empty by
 * design — no audio whose license cannot be verified is ever added — so a missing manifest,
 * or one with no matching mood, both resolve to `null`: optional music degrades gracefully
 * rather than blocking the render.
 */
export const resolveMusicPath = async (repoRoot: string, mood: string): Promise<string | null> => {
  const manifestPath = path.join(repoRoot, 'assets/music/manifest.json')
  let manifest: MusicManifest
  try {
    const raw = await fs.readFile(manifestPath, 'utf8')
    manifest = JSON.parse(raw) as MusicManifest
  } catch {
    return null
  }
  const match = manifest.tracks?.find((t) => t.mood.toLowerCase() === mood.toLowerCase())
  return match ? path.join(repoRoot, 'assets/music', match.file) : null
}
