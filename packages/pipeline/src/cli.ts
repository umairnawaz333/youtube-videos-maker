import path from 'node:path'
import type { AppConfig, ProviderBundle, RunContext, Stage } from '@yt/core'
import { createRepositories, createPrismaClient, type Repositories } from '@yt/db'
import { createFakeProviders, FixedClock } from '@yt/providers'
import { loadConfig } from './config/load'
import {
  buildDefaultChecks,
  nodeCommandRunner,
  nodeFsProbe,
  runDoctor,
} from './doctor'
import { EventRunLogger, type LogEntry } from './logger'
import { ModelBroker, type Evictable } from './model-broker'
import { StageRunner, type RunResult } from './stage-runner'
import { FileArtifactStore } from './storage/artifacts'
import { ensureRunDirs, runPaths } from './storage/paths'
import { buildNoopStages } from './testing/noop-stages'

export interface RunPipelineOptions {
  runId: string
  repos: Repositories
  configDir: string
  storageRoot: string
  request?: Partial<AppConfig>
  /** Uses fake providers and placeholder stages. Real wiring arrives in Plans 2-4. */
  useFakes?: boolean
  stages?: Stage[]
  providers?: ProviderBundle
  onLog?: (entry: LogEntry) => void
  nowIso?: string
}

export const runPipeline = async (opts: RunPipelineOptions): Promise<RunResult> => {
  const config = await loadConfig({ configDir: opts.configDir, request: opts.request })
  const clock = new FixedClock(opts.nowIso ?? '2026-08-01T10:00:00.000Z')

  const existing = await opts.repos.runs.get(opts.runId)
  if (!existing) {
    await opts.repos.runs.create({
      id: opts.runId,
      niche: config.niche,
      format: config.videoType,
      createdAt: clock.now(),
    })
  }

  const paths = runPaths(opts.storageRoot, opts.runId)
  await ensureRunDirs(paths)

  // useFakes must be explicit: silently falling back to fakes would let a misconfigured
  // real run produce a fake video that looks genuine.
  if (!opts.providers && !opts.useFakes) {
    throw new Error(
      'runPipeline requires `providers`, or `useFakes: true` until Plan 2 wires real adapters',
    )
  }

  // useFakes and explicit providers/stages are mutually exclusive. Mixing them would let
  // real stages run against fake providers — a video assembled from a one-pixel PNG and a
  // sine-wave WAV, reported as a genuine finished run with nothing to flag it as fake.
  if (opts.useFakes && (opts.providers || opts.stages)) {
    throw new Error(
      'runPipeline: `useFakes` cannot be combined with explicit `providers` or `stages` — ' +
        'doing so would let real stages run against fake providers and silently report a ' +
        'fake video as a genuine finished run. Pass `useFakes: true` alone for an all-fake ' +
        'smoke run, or pass your own `providers`/`stages` without `useFakes`.',
    )
  }

  const providers = opts.providers ?? createFakeProviders()
  const stages = opts.stages ?? buildNoopStages()

  // The broker owns eviction; providers expose unload, never called by a stage.
  const evictables: Evictable[] = [
    { id: 'llm', unload: () => providers.llm.unload() },
    { id: 'sd', unload: () => providers.image.unload() },
  ]

  const ctx: RunContext = {
    runId: opts.runId,
    config,
    paths,
    artifacts: new FileArtifactStore(paths),
    topics: opts.repos.topics,
    clipRequests: opts.repos.clips,
    providers,
    log: new EventRunLogger(opts.runId, opts.onLog ?? (() => {})),
    clock,
  }

  const runner = new StageRunner({
    stages,
    broker: new ModelBroker(evictables),
    repos: opts.repos,
    clock,
  })

  return runner.execute(ctx)
}

const repoRoot = path.resolve(__dirname, '../../..')

const main = async () => {
  const verb = process.argv[2]

  if (verb === 'doctor') {
    const report = await runDoctor(
      buildDefaultChecks({ cmd: nodeCommandRunner(), fs: nodeFsProbe(), repoRoot }),
    )
    for (const r of report.results) {
      const mark = r.ok ? 'PASS' : r.required ? 'FAIL' : 'WARN'
      console.log(`${mark.padEnd(4)}  ${r.name.padEnd(18)}  ${r.detail}`)
    }
    console.log(report.ok ? '\nAll required checks passed.' : '\nRequired checks failed.')
    // Set exitCode and return rather than process.exit(): exit() can cut off stdout that
    // hasn't finished flushing yet (e.g. when piped), truncating output for the caller.
    process.exitCode = report.ok ? 0 : 1
    return
  }

  if (verb === 'run') {
    const databaseUrl = process.env.DATABASE_URL ?? `file:${path.join(repoRoot, 'storage/factory.db')}`
    const prisma = createPrismaClient(databaseUrl)
    const runId = process.argv[3] ?? `run-${process.pid}`

    // The disconnect must happen whether runPipeline resolves or rejects — a database
    // failure at run start (before StageRunner's own try/finally is established) is a
    // real, reachable throw, not a theoretical one, and it must not leave a dangling
    // connection behind.
    try {
      const result = await runPipeline({
        runId,
        repos: createRepositories(prisma),
        configDir: path.join(repoRoot, 'config'),
        storageRoot: process.env.STORAGE_ROOT ?? path.join(repoRoot, 'storage'),
        useFakes: true,
        onLog: (entry) => console.log(`[${entry.level}] ${entry.message}`),
      })

      console.log(`\nrun ${runId} finished with status: ${result.status}`)
      if (result.reason) console.log(`reason: ${result.reason}`)
      process.exitCode = result.status === 'failed' ? 1 : 0
    } finally {
      await prisma.$disconnect()
    }
    return
  }

  console.error('usage: pipeline <run|doctor> [runId]')
  process.exitCode = 2
}

if (require.main === module) {
  // Without this catch, any error thrown by main() (a config load failure, a database
  // error at run start, an unexpected rejection) becomes an unhandled promise rejection
  // instead of a controlled, non-zero exit — and the message the user sees is a bare
  // stack dump instead of something legible.
  main().catch((error) => {
    console.error(`pipeline CLI failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
