import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ThumbnailJob, VideoSpec } from '@yt/core'

const execFileAsync = promisify(execFile)

/**
 * The seam between the Editor stage and the actual Remotion project (`services/renderer`).
 * `packages/pipeline` never imports react/remotion directly — the real renderer runs
 * out-of-process — which is what lets the unit suite inject a fake here instead of paying for
 * headless Chromium (constraint: no real Remotion render in the unit suite).
 */
export interface VideoRenderer {
  /** Renders `spec` to `outPath` (H.264, the spec's own fps/resolution) and reports its
   * actual encoded duration, which QualityGate later compares back against the spec. */
  renderVideo(spec: VideoSpec, outPath: string): Promise<{ durationSec: number }>
  /** Composites each job's text overlay onto its source hero image and writes `outPath`. */
  renderThumbnails(jobs: ThumbnailJob[]): Promise<void>
}

export interface ChildProcessRendererOptions {
  /** Root of the Remotion project. Defaults to `<repoRoot>/services/renderer`. */
  rendererDir?: string
  repoRoot?: string
}

const resolveRendererDir = (opts: ChildProcessRendererOptions): string =>
  opts.rendererDir ?? path.join(opts.repoRoot ?? process.cwd(), 'services/renderer')

/**
 * Real adapter: spawns the Remotion render entry points in `services/renderer` as child
 * processes via `tsx` (already a root devDependency), so a heavy render never shares a
 * process — or crashes — with the orchestrator. Never invoked by the unit suite. Requires
 * `pnpm install` to have been run inside `services/renderer` first; see the render-block
 * report for why that step was deliberately left to the owner.
 */
export const createChildProcessRenderer = (opts: ChildProcessRendererOptions = {}): VideoRenderer => {
  const rendererDir = resolveRendererDir(opts)

  return {
    async renderVideo(spec, outPath) {
      const specPath = `${outPath}.spec.json`
      await fs.mkdir(path.dirname(specPath), { recursive: true })
      await fs.writeFile(specPath, JSON.stringify(spec), 'utf8')
      const { stdout } = await execFileAsync(
        'npx',
        ['tsx', path.join(rendererDir, 'src/render.ts'), '--spec', specPath, '--out', outPath],
        { cwd: rendererDir },
      )
      return JSON.parse(stdout) as { durationSec: number }
    },

    async renderThumbnails(jobs) {
      if (jobs.length === 0) return
      const jobsPath = path.join(rendererDir, `.thumbnail-jobs-${Date.now()}-${process.pid}.json`)
      await fs.writeFile(jobsPath, JSON.stringify(jobs), 'utf8')
      try {
        await execFileAsync(
          'npx',
          ['tsx', path.join(rendererDir, 'src/render-thumbnails.ts'), '--jobs', jobsPath],
          { cwd: rendererDir },
        )
      } finally {
        await fs.rm(jobsPath, { force: true })
      }
    },
  }
}
