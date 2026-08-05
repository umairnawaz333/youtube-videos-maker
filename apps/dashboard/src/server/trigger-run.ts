import { spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ensureRunDirs, runPaths } from '@yt/pipeline'
import { databaseUrl, repoRoot, storageRoot } from './env'

export type SpawnFn = typeof nodeSpawn

export interface TriggerRunDeps {
  /** Injected in tests so no real process is ever spawned by the unit suite. */
  spawn?: SpawnFn
  now?: () => Date
  /** Injected in tests for a deterministic run id. */
  randomSuffix?: () => string
}

export interface TriggerRunResult {
  runId: string
  logPath: string
  statusPath: string
}

const defaultRandomSuffix = () => Math.random().toString(36).slice(2, 6)

/**
 * The Generate button's seam onto the pipeline — and deliberately the ONLY one.
 *
 * This does not reimplement stage or provider wiring. It shells out to
 * `pnpm run pipeline:run <runId>`, the exact command a person types by hand today (see root
 * package.json's `pipeline:run` script and `packages/pipeline/src/cli.ts`'s `run` verb, which
 * owns model health checks, provider construction, and the `Run` row's creation via
 * `runPipeline`). Reusing the command rather than the internals means this file can never
 * drift from what the CLI actually does: there is exactly one run-creation path, and it is
 * not this file.
 *
 * The child is detached and `unref()`'d because a run takes 10-60 minutes: it must outlive
 * this request, and it must not keep the dashboard's own process alive on its account either.
 *
 * `DATABASE_URL` and `STORAGE_ROOT` are forwarded explicitly (computed the same way the CLI
 * itself defaults them — see `./env.ts`) so that if the dashboard is ever started with either
 * overridden, the pipeline it spawns writes to the exact place the dashboard reads from.
 */
export const triggerRun = async (deps: TriggerRunDeps = {}): Promise<TriggerRunResult> => {
  const spawn = deps.spawn ?? nodeSpawn
  const now = deps.now ?? (() => new Date())
  const randomSuffix = deps.randomSuffix ?? defaultRandomSuffix

  const runId = `run-${now().getTime().toString(36)}-${randomSuffix()}`
  const paths = runPaths(storageRoot(), runId)
  await ensureRunDirs(paths)

  const logPath = path.join(paths.root, 'pipeline.log')
  const statusPath = path.join(paths.root, 'pipeline.status.json')

  const writeStatus = async (status: Record<string, unknown>): Promise<void> => {
    await fsp.writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8')
  }

  // Written before the process is even spawned, so the run detail page has something to read
  // (and can tell "queued, about to start" apart from "no such run") the instant it redirects
  // here — well before the pipeline's own first database write.
  await writeStatus({ runId, command: 'pnpm run pipeline:run', startedAt: now().toISOString() })

  const child = spawn('pnpm', ['run', 'pipeline:run', runId], {
    cwd: repoRoot(),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl(),
      STORAGE_ROOT: storageRoot(),
    },
  })

  const logStream = fs.createWriteStream(logPath, { flags: 'a' })
  child.stdout?.pipe(logStream)
  child.stderr?.pipe(logStream)

  // If `pnpm` itself can't be found or spawned, the pipeline never creates a `Run` row at
  // all — that failure needs to be visible somewhere other than a dangling "queued" screen.
  child.on('error', (error) => {
    void writeStatus({
      runId,
      command: 'pnpm run pipeline:run',
      startedAt: now().toISOString(),
      failedToStart: true,
      error: error.message,
    })
  })

  child.on('exit', (code, signal) => {
    void writeStatus({
      runId,
      command: 'pnpm run pipeline:run',
      exitCode: code,
      signal,
      finishedAt: now().toISOString(),
    })
  })

  child.unref()

  return { runId, logPath, statusPath }
}
