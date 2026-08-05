import path from 'node:path'
import type { RunPaths } from '@yt/core'

/**
 * Filename conventions shared by every render-block stage (ClipGate, Editor, QualityGate) for
 * locating a scene's generated assets. Illustrator writes one image per scene id — including
 * the fallback image for a `veo-clip` scene, generated from `fallbackPrompt` — and Narrator
 * writes one narration file per scene id. Centralised here so the convention is declared once
 * and every consumer (including the sibling audio/image-block stages once wired) agrees.
 */
export const sceneImagePath = (paths: RunPaths, sceneId: string): string =>
  path.join(paths.images, `${sceneId}.png`)

export const sceneAudioPath = (paths: RunPaths, sceneId: string): string =>
  path.join(paths.audio, `${sceneId}.wav`)

export const sceneClipInboxPath = (paths: RunPaths, sceneId: string): string =>
  path.join(paths.clipsInbox, `${sceneId}.mp4`)

export const sceneClipNormalisedPath = (paths: RunPaths, sceneId: string): string =>
  path.join(paths.clipsNormalised, `${sceneId}.mp4`)

/** `clips/` itself — the parent of `clipsInbox`/`clipsNormalised` — for REQUESTS.md and state. */
export const clipsRootPath = (paths: RunPaths): string => path.dirname(paths.clipsInbox)
