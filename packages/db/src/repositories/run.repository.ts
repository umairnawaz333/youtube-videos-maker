import type { RunStatus, StageName, VideoFormat } from '@yt/core'
import type { PrismaClient } from '../client'

export interface StageRecord {
  name: StageName
  status: 'running' | 'done' | 'failed'
  attempts: number
  error: string | null
}

export class RunRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: {
    id: string
    niche: string
    format: VideoFormat
    createdAt: Date
  }): Promise<void> {
    await this.prisma.run.create({
      data: { ...input, status: 'queued', updatedAt: input.createdAt },
    })
  }

  async get(id: string) {
    const run = await this.prisma.run.findUnique({ where: { id } })
    return run as (Omit<NonNullable<typeof run>, 'status'> & { status: RunStatus }) | null
  }

  /**
   * Newest first, for the dashboard's run list. Exists so the dashboard reads runs through this
   * repository like every other consumer, rather than reaching past it into Prisma directly —
   * the status cast below is the reason: it belongs in one place, not at each call site.
   */
  async list() {
    const runs = await this.prisma.run.findMany({ orderBy: { createdAt: 'desc' } })
    return runs as (Omit<(typeof runs)[number], 'status'> & { status: RunStatus })[]
  }

  async setStatus(id: string, status: RunStatus): Promise<void> {
    await this.prisma.run.update({ where: { id }, data: { status } })
  }

  async recordVideoId(id: string, videoId: string): Promise<void> {
    await this.prisma.run.update({ where: { id }, data: { videoId } })
  }

  /** Upserts so a retry of the same stage increments attempts rather than duplicating. */
  async startStage(runId: string, name: StageName, at: Date): Promise<void> {
    await this.prisma.stageRun.upsert({
      where: { runId_name: { runId, name } },
      create: { runId, name, status: 'running', attempts: 1, startedAt: at },
      update: { status: 'running', attempts: { increment: 1 }, startedAt: at, error: null },
    })
  }

  async finishStage(runId: string, name: StageName, at: Date): Promise<void> {
    await this.prisma.stageRun.update({
      where: { runId_name: { runId, name } },
      data: { status: 'done', endedAt: at, error: null },
    })
  }

  async failStage(runId: string, name: StageName, error: string, at: Date): Promise<void> {
    await this.prisma.stageRun.update({
      where: { runId_name: { runId, name } },
      data: { status: 'failed', error, endedAt: at },
    })
  }

  async stages(runId: string): Promise<StageRecord[]> {
    const rows = await this.prisma.stageRun.findMany({ where: { runId }, orderBy: { id: 'asc' } })
    return rows.map((r) => ({
      name: r.name as StageName,
      status: r.status as StageRecord['status'],
      attempts: r.attempts,
      error: r.error,
    }))
  }

  /** The resume mechanism: stages already done are skipped on a re-run. */
  async completedStages(runId: string): Promise<StageName[]> {
    const rows = await this.prisma.stageRun.findMany({
      where: { runId, status: 'done' },
      orderBy: { id: 'asc' },
    })
    return rows.map((r) => r.name as StageName)
  }
}
