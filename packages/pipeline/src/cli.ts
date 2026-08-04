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
    process.exit(report.ok ? 0 : 1)
  }

  if (verb === 'run') {
    const databaseUrl = process.env.DATABASE_URL ?? `file:${path.join(repoRoot, 'storage/factory.db')}`
    const prisma = createPrismaClient(databaseUrl)
    const runId = process.argv[3] ?? `run-${process.pid}`

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
    await prisma.$disconnect()
    process.exit(result.status === 'failed' ? 1 : 0)
  }

  console.error('usage: pipeline <run|doctor> [runId]')
  process.exit(2)
}

if (require.main === module) {
  void main()
}
