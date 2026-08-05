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

/** Lists every run, newest first, for the dashboard's home page. */
export const listRuns = async (): Promise<RunSummary[]> => {
  const runs = await getRepos().runs.list()
  return runs.map((r) => ({
    id: r.id,
    niche: r.niche,
    format: r.format as VideoFormat,
    status: r.status,
    videoId: r.videoId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }))
}
