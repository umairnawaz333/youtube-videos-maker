import { STAGE_NAMES, STAGE_REQUIREMENTS, STAGE_RETRY_KIND } from '@yt/core'
import type { Clock, RunContext, RunStatus, Stage, StageName } from '@yt/core'
import type { Repositories } from '@yt/db'
import { ModelBroker } from './model-broker'
import { attemptsFor } from './retry'

export interface StageRunnerDeps {
  stages: Stage[]
  broker: ModelBroker
  repos: Repositories
  clock: Clock
  /** Injected so backoff is instant in tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
}

export interface RunResult {
  status: RunStatus
  stoppedAt?: StageName
  reason?: string
}

export class StageRunner {
  constructor(private readonly deps: StageRunnerDeps) {
    const names = deps.stages.map((s) => s.name)

    const seen = new Set<StageName>()
    for (const name of names) {
      if (seen.has(name)) {
        throw new Error(`StageRunner: duplicate stage '${name}' in the stage list`)
      }
      seen.add(name)
    }

    // Resume correctness depends on the list being a leading prefix of the canonical
    // order: `completedStages` is matched by name, so a reordered or gapped list would
    // silently change which stages are skipped on resume.
    const expected = STAGE_NAMES.slice(0, names.length)
    if (names.join('|') !== expected.join('|')) {
      throw new Error(
        `StageRunner: stages must be a leading prefix of the canonical order. ` +
          `Expected ${expected.join(', ')} but got ${names.join(', ')}`,
      )
    }

    for (const stage of deps.stages) {
      if (stage.requires !== STAGE_REQUIREMENTS[stage.name]) {
        throw new Error(
          `StageRunner: stage '${stage.name}' declares requires='${stage.requires}' but the ` +
            `canonical map says '${STAGE_REQUIREMENTS[stage.name]}'. The memory grouping ` +
            `depends on these agreeing.`,
        )
      }
    }
  }

  async execute(ctx: RunContext): Promise<RunResult> {
    const { stages, broker, repos, clock } = this.deps
    const completed = new Set(await repos.runs.completedStages(ctx.runId))

    await repos.runs.setStatus(ctx.runId, 'running')

    try {
      for (const stage of stages) {
        if (completed.has(stage.name)) {
          ctx.log.info(`skipping ${stage.name}, already completed`, { stage: stage.name })
          continue
        }

        const outcome = await this.runWithRetry(ctx, stage)

        if (outcome.kind === 'failed') {
          await repos.runs.setStatus(ctx.runId, 'failed')
          return { status: 'failed', stoppedAt: stage.name, reason: outcome.reason }
        }

        if (outcome.kind === 'halted') {
          await repos.runs.setStatus(ctx.runId, 'failed')
          return { status: 'failed', stoppedAt: stage.name, reason: outcome.reason }
        }

        if (outcome.kind === 'paused') {
          // Deliberately not marked done: the stage re-runs on resume to collect the
          // assets the human supplied while the run was paused.
          //
          // The status comes from the stage's own pause reason rather than being hardcoded —
          // ClipGate waits for uploaded footage ('awaiting_clips'), the Publisher waits for the
          // review click ('awaiting_review'), and recording either as the other would mislead
          // the dashboard about what the run is actually waiting for.
          await repos.runs.setStatus(ctx.runId, outcome.reason)
          ctx.log.info(`paused ${outcome.reason.replace('_', ' ')}`, { stage: stage.name })
          return { status: outcome.reason, stoppedAt: stage.name }
        }

        await repos.runs.finishStage(ctx.runId, stage.name, clock.now())
        ctx.log.info(`completed ${stage.name}`, { stage: stage.name })
      }

      await repos.runs.setStatus(ctx.runId, 'awaiting_review')
      return { status: 'awaiting_review' }
    } finally {
      // Always attempt to give the memory back, however the run ended. This must not
      // rethrow: a throw from a `finally` block replaces whatever the `try` block above
      // already returned, so a rejecting evictAll() here would silently discard the
      // RunResult we just computed and make execute() reject instead of resolve —
      // exactly the contract violation the acquire() amendment closed on the other
      // path. The run's outcome is already decided and stays accurate regardless of
      // whether cleanup succeeds (a failed video run is still failed; a produced video
      // is still produced); a stuck model only affects the *next* run's first
      // acquire(), which will surface the repeat failure as a normal stage failure.
      try {
        await broker.evictAll()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.log.error(`model memory was NOT released after the run: ${message}`, {
          resident: broker.resident,
        })
      }
    }
  }

  private async runWithRetry(
    ctx: RunContext,
    stage: Stage,
  ): Promise<
    | { kind: 'done' }
    | { kind: 'paused'; reason: 'awaiting_clips' | 'awaiting_review' }
    | { kind: 'halted'; reason: string }
    | { kind: 'failed'; reason: string }
  > {
    const { broker, repos, clock } = this.deps
    const maxAttempts = attemptsFor(stage, ctx.config.retries)
    let lastError = 'unknown error'

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await repos.runs.startStage(ctx.runId, stage.name, clock.now())

      // acquire() can reject: it throws for an unregistered model id, and also if the
      // incumbent model's unload() fails. It must stay outside the try/finally below —
      // that finally unconditionally calls lease.release(), and a rejection here would
      // otherwise leave `lease` undefined at the point release() is called. Treat a
      // rejection as an attempt failure, same as a throwing stage, and move on to the
      // next attempt (or exhaust the budget and report `failed`).
      let lease
      try {
        lease = await broker.acquire(stage.requires)
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        ctx.log.warn(`${stage.name} attempt ${attempt}/${maxAttempts} failed: ${lastError}`, {
          stage: stage.name,
          attempt,
        })
        await repos.runs.failStage(ctx.runId, stage.name, lastError, clock.now())
        continue
      }

      try {
        const outcome = await stage.run(ctx)
        if (outcome.status === 'paused') return { kind: 'paused', reason: outcome.reason }
        if (outcome.status === 'halted') {
          await repos.runs.failStage(ctx.runId, stage.name, outcome.reason, clock.now())
          return { kind: 'halted', reason: outcome.reason }
        }
        return { kind: 'done' }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        ctx.log.warn(`${stage.name} attempt ${attempt}/${maxAttempts} failed: ${lastError}`, {
          stage: stage.name,
          attempt,
        })
        await repos.runs.failStage(ctx.runId, stage.name, lastError, clock.now())

        const backoff = ctx.config.retries.backoffMs[STAGE_RETRY_KIND[stage.name]]
        if (attempt < maxAttempts && backoff > 0) {
          const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
          // Doubling: attempt 1 waits `backoff`, attempt 2 waits `backoff * 2`.
          await sleep(backoff * 2 ** (attempt - 1))
        }
      } finally {
        lease.release()
      }
    }

    return { kind: 'failed', reason: `${stage.name} failed after ${maxAttempts} attempts: ${lastError}` }
  }
}
