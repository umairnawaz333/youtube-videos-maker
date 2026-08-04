import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPrismaClient, createRepositories, type Repositories } from '@yt/db'
import { TEMPLATE_DB } from './global-db'

let counter = 0

export const createTestDb = async (): Promise<{
  prisma: ReturnType<typeof createPrismaClient>
  repos: Repositories
  cleanup: () => Promise<void>
}> => {
  counter += 1
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `yt-db-${counter}-`))
  const file = path.join(dir, 'test.db')
  await fs.copyFile(TEMPLATE_DB, file)

  const prisma = createPrismaClient(`file:${file}`)
  return {
    prisma,
    repos: createRepositories(prisma),
    cleanup: async () => {
      await prisma.$disconnect()
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}
