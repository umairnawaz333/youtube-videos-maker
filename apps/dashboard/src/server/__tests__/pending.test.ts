import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureRunDirs, runPaths } from '@yt/pipeline'
import { readPendingRunInfo } from '../pending'

describe('readPendingRunInfo', () => {
  let tmpRoot: string
  const runId = 'run-pending-1'

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dashboard-pending-'))
    process.env.STORAGE_ROOT = tmpRoot
  })

  afterEach(async () => {
    delete process.env.STORAGE_ROOT
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  it('reports not found when the trigger seam never wrote anything for this run id', async () => {
    const info = await readPendingRunInfo('run-does-not-exist')
    expect(info.found).toBe(false)
  })

  it('reports a plain in-flight status while the process is still starting', async () => {
    const paths = runPaths(tmpRoot, runId)
    await ensureRunDirs(paths)
    await fs.writeFile(
      path.join(paths.root, 'pipeline.status.json'),
      JSON.stringify({ runId, command: 'pnpm run pipeline:run' }),
    )

    const info = await readPendingRunInfo(runId)
    expect(info.found).toBe(true)
    expect(info.failedToStart).toBe(false)
    expect(info.exitCode).toBeNull()
  })

  it('surfaces a failure to even start the process', async () => {
    const paths = runPaths(tmpRoot, runId)
    await ensureRunDirs(paths)
    await fs.writeFile(
      path.join(paths.root, 'pipeline.status.json'),
      JSON.stringify({ runId, failedToStart: true, error: 'spawn pnpm ENOENT' }),
    )

    const info = await readPendingRunInfo(runId)
    expect(info.failedToStart).toBe(true)
  })

  it('surfaces the exit code and a tail of the log when the process exited early', async () => {
    const paths = runPaths(tmpRoot, runId)
    await ensureRunDirs(paths)
    await fs.writeFile(path.join(paths.root, 'pipeline.status.json'), JSON.stringify({ runId, exitCode: 1 }))
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`)
    await fs.writeFile(path.join(paths.root, 'pipeline.log'), lines.join('\n'))

    const info = await readPendingRunInfo(runId)
    expect(info.exitCode).toBe(1)
    expect(info.logTail).toContain('line 99')
    expect(info.logTail).not.toContain('line 0\n')
  })
})
