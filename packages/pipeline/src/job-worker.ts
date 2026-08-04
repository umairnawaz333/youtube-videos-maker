import type { Clock } from '@yt/core'
import type { ClaimedJob, Repositories } from '@yt/db'

export interface JobWorkerDeps {
  repos: Repositories
  clock: Clock
  /** Concurrency is fixed at 1: the memory constraint makes parallel runs impossible. */
  maxAttempts?: number
  handler: (job: ClaimedJob) => Promise<void>
}

export class JobWorker {
  private readonly maxAttempts: number

  constructor(private readonly deps: JobWorkerDeps) {
    this.maxAttempts = deps.maxAttempts ?? 3
  }

  /** Processes at most one job. Returns false when the queue is empty. */
  async tick(): Promise<boolean> {
    const { repos, clock, handler } = this.deps
    const job = await repos.jobs.claimNext(clock.now())
    if (!job) return false

    try {
      await handler(job)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await repos.jobs.fail(job.id, message, this.maxAttempts, clock.now())
      return true
    }

    // The handler already succeeded by this point, so the work is genuinely
    // done. A failure here is bookkeeping corruption in recording that
    // success, not a job failure, and must never call fail()/requeue: doing
    // so would silently re-run an already-successful job (a whole pipeline
    // run, e.g. regenerating a video that already completed). Let it
    // propagate so the operator sees the real, unexpected problem.
    await repos.jobs.complete(job.id, clock.now())
    return true
  }

  /** Drains the queue, including retries. Returns the number of jobs processed. */
  async drain(): Promise<number> {
    let processed = 0
    while (await this.tick()) processed += 1
    return processed
  }
}
