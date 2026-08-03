import type { TopicStore } from '@yt/core'
import type { PrismaClient } from '../client'

export class TopicRepository implements TopicStore {
  constructor(private readonly prisma: PrismaClient) {}

  async hasUsed(key: string): Promise<boolean> {
    return (await this.prisma.topic.findUnique({ where: { key } })) !== null
  }

  async markUsed(key: string, title: string): Promise<void> {
    await this.prisma.topic.upsert({ where: { key }, create: { key, title }, update: {} })
  }
}
