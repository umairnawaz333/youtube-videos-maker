import { createPrismaClient, createRepositories, type PrismaClient, type Repositories } from '@yt/db'
import type { RunStatus, VideoFormat } from '@yt/core'
import { databaseUrl } from './env'

// A module-level singleton: Next.js keeps this module resident across requests within one
// server process (both `next dev` and `next start`), so a fresh PrismaClient per request
// would leak SQLite connections. Route handlers and server actions all import this file.
let client: PrismaClient | undefined

export const getPrisma = (): PrismaClient => {
  client ??= createPrismaClient(databaseUrl())
  return client
}

export const getRepos = (): Repositories => createRepositories(getPrisma())

export interface RunSummary {
  id: string
  niche: string
  format: VideoFormat
  status: RunStatus
  videoId: string | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Lists every run, newest first, for the dashboard's home page.
 *
 * `RunRepository` (packages/db/src/repositories/run.repository.ts) has no `list()` method
 * today — every other read in this app goes through it, but this one gap is filled with a
 * direct, read-only Prisma query instead. See the dashboard build report for the exact
 * `RunRepository.list()` addition this should be replaced with.
 */
export const listRuns = async (): Promise<RunSummary[]> => {
  const rows = await getPrisma().run.findMany({ orderBy: { createdAt: 'desc' } })
  return rows.map((r) => ({
    id: r.id,
    niche: r.niche,
    format: r.format as VideoFormat,
    status: r.status as RunStatus,
    videoId: r.videoId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }))
}
