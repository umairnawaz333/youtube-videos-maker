/**
 * CLI entry point for compositing the five thumbnail stills. Invoked out-of-process by
 * `packages/pipeline/src/render/renderer.ts` (`createChildProcessRenderer`). Never invoked by
 * the unit suite. Requires `pnpm install` to have been run in this directory first.
 *
 * Usage: tsx src/render-thumbnails.ts --jobs <jobs.json path>
 * `jobs.json` is a `ThumbnailJob[]` (see ../../../packages/core/src/schemas/render.ts).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { bundle } from '@remotion/bundler'
import { renderStill, selectComposition } from '@remotion/renderer'
import type { ThumbnailJob } from './types'

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
  const { jobs: jobsPath } = parseArgs(process.argv.slice(2))
  if (!jobsPath) {
    console.error('usage: render-thumbnails.ts --jobs <jobs.json>')
    process.exitCode = 1
    return
  }

  const jobs = JSON.parse(await fs.readFile(jobsPath, 'utf8')) as ThumbnailJob[]
  const bundleLocation = await bundle({ entryPoint: path.join(__dirname, 'index.ts') })

  for (const job of jobs) {
    const composition = await selectComposition({
      serveUrl: bundleLocation,
      id: 'ThumbnailStill',
      inputProps: { job },
    })
    await fs.mkdir(path.dirname(job.outPath), { recursive: true })
    await renderStill({ composition, serveUrl: bundleLocation, output: job.outPath, inputProps: { job } })
  }

  console.log(JSON.stringify({ rendered: jobs.length }))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
