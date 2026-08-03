import type { PrismaClient } from './client'
import { ClipRepository } from './repositories/clip.repository'
import { JobRepository } from './repositories/job.repository'
import { RunRepository } from './repositories/run.repository'
import { TopicRepository } from './repositories/topic.repository'

export * from './client'
export * from './repositories/clip.repository'
export * from './repositories/job.repository'
export * from './repositories/run.repository'
export * from './repositories/topic.repository'

export interface Repositories {
  runs: RunRepository
  topics: TopicRepository
  clips: ClipRepository
  jobs: JobRepository
}

export const createRepositories = (prisma: PrismaClient): Repositories => ({
  runs: new RunRepository(prisma),
  topics: new TopicRepository(prisma),
  clips: new ClipRepository(prisma),
  jobs: new JobRepository(prisma),
})
