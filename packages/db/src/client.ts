import { PrismaClient } from '../generated/client'

export const createPrismaClient = (databaseUrl: string): PrismaClient =>
  new PrismaClient({ datasources: { db: { url: databaseUrl } } })

export type { PrismaClient }
