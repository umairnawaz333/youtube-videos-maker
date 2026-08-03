import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const TEMPLATE_DB = path.resolve(__dirname, '../../storage/test-template.db')

export default function globalSetup() {
  fs.mkdirSync(path.dirname(TEMPLATE_DB), { recursive: true })
  fs.rmSync(TEMPLATE_DB, { force: true })

  const schema = path.resolve(__dirname, '../../packages/db/prisma/schema.prisma')
  execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--schema', schema, '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: `file:${TEMPLATE_DB}` },
    stdio: 'inherit',
  })
}
