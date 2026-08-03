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

  /** Concurrency is 1, so a simple find-then-update claim is sufficient here. */
  async claimNext(at: Date): Promise<ClaimedJob | null> {
    const row = await this.prisma.job.findFirst({
      where: { state: 'queued' },
      orderBy: { id: 'asc' },
    })
    if (!row) return null

    await this.prisma.job.update({
      where: { id: row.id },
      data: { state: 'running', claimedAt: at },
    })

    return {
      id: row.id,
      type: row.type,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      attempts: row.attempts,
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
