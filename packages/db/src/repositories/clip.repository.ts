import type { ClipRequestStore, StoredClipRequest } from '@yt/core'
import type { PrismaClient } from '../client'

export class ClipRepository implements ClipRequestStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(
    runId: string,
    requests: Omit<StoredClipRequest, 'fulfilledPath' | 'skipped'>[],
  ): Promise<void> {
    for (const r of requests) {
      await this.prisma.clipRequest.upsert({
        where: { runId_sceneId: { runId, sceneId: r.sceneId } },
        create: { runId, ...r },
        update: { prompt: r.prompt, targetSeconds: r.targetSeconds },
      })
    }
  }

  async listForRun(runId: string): Promise<StoredClipRequest[]> {
    const rows = await this.prisma.clipRequest.findMany({ where: { runId }, orderBy: { id: 'asc' } })
    return rows.map((r) => ({
      sceneId: r.sceneId,
      prompt: r.prompt,
      referenceImagePath: r.referenceImagePath,
      targetSeconds: r.targetSeconds,
      fulfilledPath: r.fulfilledPath,
      skipped: r.skipped,
    }))
  }

  async markFulfilled(runId: string, sceneId: string, path: string): Promise<void> {
    await this.prisma.clipRequest.update({
      where: { runId_sceneId: { runId, sceneId } },
      data: { fulfilledPath: path, skipped: false },
    })
  }

  async markSkipped(runId: string, sceneId: string): Promise<void> {
    await this.prisma.clipRequest.update({
      where: { runId_sceneId: { runId, sceneId } },
      data: { skipped: true },
    })
  }
}
