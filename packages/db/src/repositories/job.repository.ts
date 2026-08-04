import type { PrismaClient } from '../client'

export interface ClaimedJob {
  id: number
  type: string
  payload: Record<string, unknown>
  attempts: number
}

export class JobRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async enqueue(type: string, payload: Record<string, unknown>, at: Date): Promise<number> {
    const row = await this.prisma.job.create({
      data: { type, payload: JSON.stringify(payload), createdAt: at },
    })
    return row.id
  }

  /**
   * Concurrency is 1, so a simple find-then-update claim is sufficient here.
   *
   * A row whose payload is not valid JSON is a poison pill: parsing it will
   * fail the exact same way no matter how many times it is retried, so
   * requeuing it would only ever reproduce the failure and block every
   * queued job behind it. It is therefore quarantined here (marked
   * permanently failed) and the loop moves on to the next queued row,
   * skipping as many consecutive bad rows as necessary. The loop still
   * terminates: each quarantined row leaves the `queued` state, so it can
   * never be found again, and `findFirst` eventually returns null once
   * nothing queued remains.
   */
  async claimNext(at: Date): Promise<ClaimedJob | null> {
    for (;;) {
      const row = await this.prisma.job.findFirst({
        where: { state: 'queued' },
        orderBy: { id: 'asc' },
      })
      if (!row) return null

      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(row.payload) as Record<string, unknown>
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await this.prisma.job.update({
          where: { id: row.id },
          data: { state: 'failed', finishedAt: at, error: `payload is not valid JSON: ${message}` },
        })
        continue
      }

      await this.prisma.job.update({
        where: { id: row.id },
        data: { state: 'running', claimedAt: at },
      })

      return {
        id: row.id,
        type: row.type,
        payload,
        attempts: row.attempts,
      }
    }
  }

  async complete(id: number, at: Date): Promise<void> {
    await this.prisma.job.update({
      where: { id },
      data: { state: 'done', finishedAt: at, error: null },
    })
  }

  /** Requeues while attempts remain, otherwise marks the job permanently failed. */
  async fail(id: number, error: string, maxAttempts: number, at: Date): Promise<void> {
    const row = await this.prisma.job.update({
      where: { id },
      data: { attempts: { increment: 1 }, error },
    })
    await this.prisma.job.update({
      where: { id },
      data:
        row.attempts >= maxAttempts
          ? { state: 'failed', finishedAt: at }
          : { state: 'queued', claimedAt: null },
    })
  }
}
