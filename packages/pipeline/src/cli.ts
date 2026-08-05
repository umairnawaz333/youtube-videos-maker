import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  AppConfig,
  Clock,
  LlmProvider,
  ProviderBundle,
  PublishProvider,
  ResearchProvider,
  RunContext,
  Stage,
  TrendProvider,
} from '@yt/core'
import { PublishResultSchema } from '@yt/core'
import { createRepositories, createPrismaClient, type Repositories } from '@yt/db'
import {
  createFakeProviders,
  createHttpImageProvider,
  createHttpOllamaClient,
  createKokoroTtsProvider,
  createWhisperCliCaptionProvider,
  createYoutubePublishProvider,
  HttpTrendProvider,
  OllamaLlmProvider,
  WikipediaResearchProvider,
} from '@yt/providers'
import { SystemClock } from './clock'
import { loadConfig } from './config/load'
import {
  buildDefaultChecks,
  nodeCommandRunner,
  nodeFsProbe,
  runDoctor,
} from './doctor'
import { EventRunLogger, type LogEntry } from './logger'
import { ModelBroker, type Evictable } from './model-broker'
import { buildFullStages } from './stages'
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
  /** Override individual providers while keeping fakes for the rest. Used by the integration suite. */
  llm?: LlmProvider
  trend?: TrendProvider
  research?: ResearchProvider
  onLog?: (entry: LogEntry) => void
  /** Defaults to SystemClock. Tests pass a FixedClock for determinism. */
  clock?: Clock
}

export const runPipeline = async (opts: RunPipelineOptions): Promise<RunResult> => {
  const config = await loadConfig({ configDir: opts.configDir, request: opts.request })
  const clock = opts.clock ?? new SystemClock()

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
  if (!opts.providers && !opts.useFakes && !opts.llm && !opts.trend && !opts.research) {
    throw new Error(
      'runPipeline requires `providers` (optionally with individual `llm`/`trend`/`research` ' +
        'overrides), or `useFakes: true` until Plan 2 wires real adapters',
    )
  }

  // useFakes and explicit providers/stages/overrides are mutually exclusive. Mixing them would
  // let real stages run against fake providers — a video assembled from a one-pixel PNG and a
  // sine-wave WAV, reported as a genuine finished run with nothing to flag it as fake.
  if (opts.useFakes && (opts.providers || opts.stages || opts.llm || opts.trend || opts.research)) {
    throw new Error(
      'runPipeline: `useFakes` cannot be combined with explicit `providers`, `stages`, or ' +
        'individual provider overrides (`llm`/`trend`/`research`) — doing so would let real ' +
        'stages run against fake providers and silently report a fake video as a genuine ' +
        'finished run. Pass `useFakes: true` alone for an all-fake smoke run, or pass your own ' +
        '`providers`/`stages`/overrides without `useFakes`.',
    )
  }

  const suppliedProviders = opts.providers ?? createFakeProviders()
  const providers: ProviderBundle = {
    ...suppliedProviders,
    ...(opts.llm ? { llm: opts.llm } : {}),
    ...(opts.trend ? { trend: opts.trend } : {}),
    ...(opts.research ? { research: opts.research } : {}),
  }
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

  const result = await runner.execute(ctx)

  // The Publisher records its upload by writing publish-result.json, because RunContext
  // deliberately exposes no `runs` repository to stages. Reading it back here is the one place
  // that owns both the repositories and the finished run, so the video id reaches the Run row
  // without widening the stage contract.
  if (result.status === 'published' || result.status === 'awaiting_review') {
    await recordPublishedVideoId(paths.root, opts.runId, opts.repos)
  }

  return result
}

/**
 * Best-effort: a run that never reached the Publisher has no result file, which is normal and
 * not an error. A malformed one is worth a warning but must not fail a run whose video is
 * already uploaded.
 */
const recordPublishedVideoId = async (
  runRoot: string,
  runId: string,
  repos: Repositories,
): Promise<void> => {
  let raw: string
  try {
    raw = await fs.readFile(path.join(runRoot, 'publish-result.json'), 'utf8')
  } catch {
    return
  }

  const parsed = PublishResultSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) return

  await repos.runs.recordVideoId(runId, parsed.data.videoId)
  await repos.runs.setStatus(runId, 'published')
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
    const host = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'
    const model = process.env.LLM_MODEL ?? 'qwen3:8b'
    const llm = new OllamaLlmProvider({
      client: createHttpOllamaClient({ host }),
      model,
      log: (message) => console.log(`[llm] ${message}`),
    })

    // The provider does not start a server, so a run with nothing listening would fail six
    // stages in a row with a connection error. Check up front so the operator gets one clear
    // message instead of debugging what looks like a broken stage.
    try {
      await llm.complete('Reply with OK')
    } catch (error) {
      console.error(
        `pipeline CLI failed: the model server at ${host} is unreachable ` +
          `(${error instanceof Error ? error.message : String(error)}). ` +
          "Run 'pnpm ollama:serve' to start it.",
      )
      process.exitCode = 1
      return
    }

    const databaseUrl = process.env.DATABASE_URL ?? `file:${path.join(repoRoot, 'storage/factory.db')}`
    const prisma = createPrismaClient(databaseUrl)
    const runId = process.argv[3] ?? `run-${process.pid}`
    const storageRoot = process.env.STORAGE_ROOT ?? path.join(repoRoot, 'storage')

    // Every media provider is real here. Leaving any of them as a fake would be worse than a
    // crash: createFakeProviders() emits a solid-colour PNG and a sine-wave WAV, so an
    // unwired provider yields a run that reports success and produces a video nobody would
    // watch, with nothing in the output marking it as fake.
    const image = createHttpImageProvider({
      host: process.env.IMAGEGEN_HOST ?? 'http://127.0.0.1:8188',
    })
    const tts = createKokoroTtsProvider({
      modelPath: process.env.KOKORO_MODEL_PATH ?? path.join(repoRoot, 'models/tts/kokoro-v1.0.onnx'),
      voicesPath: process.env.KOKORO_VOICES_PATH ?? path.join(repoRoot, 'models/tts/voices-v1.0.bin'),
      pythonBin: process.env.PYTHON_BIN ?? path.join(repoRoot, '.venv/bin/python3'),
    })
    const caption = createWhisperCliCaptionProvider({
      modelPath:
        process.env.WHISPER_MODEL_PATH ?? path.join(repoRoot, 'models/whisper/ggml-base.en.bin'),
    })

    // Constructed lazily, and deliberately NOT eagerly: createYoutubePublishProvider() reads
    // the OAuth credentials at construction time and throws when they are absent. Building it
    // up front would make every run fail before topic-scout on a machine that has no YouTube
    // credentials yet — even though the Publisher only uploads after the review click, and the
    // other thirteen stages need no credentials at all. Deferring means the missing-credential
    // error surfaces from the one stage that actually needs them, saying exactly what is missing.
    const publish: PublishProvider = {
      async publish(request) {
        return createYoutubePublishProvider({ storageRoot }).publish(request)
      },
    }

    // The disconnect must happen whether runPipeline resolves or rejects — a database
    // failure at run start (before StageRunner's own try/finally is established) is a
    // real, reachable throw, not a theoretical one, and it must not leave a dangling
    // connection behind.
    try {
      const result = await runPipeline({
        runId,
        repos: createRepositories(prisma),
        configDir: path.join(repoRoot, 'config'),
        storageRoot,
        // Fakes supply only `clip`, whose real provider is per-run (it needs the run's own
        // clips/ paths) and is constructed by the stage from ctx. Every other provider below is
        // real, so no media asset can silently come from a fake.
        providers: { ...createFakeProviders(), image, tts, caption, publish },
        stages: buildFullStages(),
        llm,
        trend: new HttpTrendProvider({ log: (m) => console.log(`[trend] ${m}`) }),
        research: new WikipediaResearchProvider({ log: (m) => console.log(`[research] ${m}`) }),
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
