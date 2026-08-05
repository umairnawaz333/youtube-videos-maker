/**
 * CLI entry point for a real video render. Invoked out-of-process by
 * `packages/pipeline/src/render/renderer.ts` (`createChildProcessRenderer`), never by the
 * unit suite and never by this worktree — headless Chromium and a real render are explicitly
 * out of scope here (see the render-block report). Requires `pnpm install` to have been run
 * in this directory first.
 *
 * Usage: tsx src/render.ts --spec <videoSpec.json path> --out <video.mp4 path>
 * On success, prints `{"durationSec": <number>}` to stdout — the shape the pipeline seam
 * expects back.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { bundle } from '@remotion/bundler'
import { renderMedia, selectComposition } from '@remotion/renderer'
import type { VideoSpec } from './types'

const parseArgs = (argv: string[]): Record<string, string> => {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key?.startsWith('--') && value) args[key.slice(2)] = value
  }
  return args
}

const main = async () => {
  const { spec: specPath, out: outPath } = parseArgs(process.argv.slice(2))
  if (!specPath || !outPath) {
    console.error('usage: render.ts --spec <videoSpec.json> --out <video.mp4>')
    process.exitCode = 1
    return
  }

  const spec = JSON.parse(await fs.readFile(specPath, 'utf8')) as VideoSpec

  const bundleLocation = await bundle({ entryPoint: path.join(__dirname, 'index.ts') })
  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: 'MainVideo',
    inputProps: { spec },
  })

  await fs.mkdir(path.dirname(outPath), { recursive: true })
  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: 'h264',
    outputLocation: outPath,
    inputProps: { spec },
    // The format presets are both already 30fps H.264 — fps/dimensions come from the
    // composition's own calculateMetadata, driven by the spec, so nothing is duplicated here.
  })

  console.log(JSON.stringify({ durationSec: spec.durationSec }))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
