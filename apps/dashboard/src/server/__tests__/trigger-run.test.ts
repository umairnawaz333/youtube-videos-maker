import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpawnFn } from '../trigger-run'
import { triggerRun } from '../trigger-run'

/**
 * A fake child process. No real process is ever spawned by this suite — that is the whole
 * point of `triggerRun` taking an injectable `spawn`: a pipeline run takes 10-60 minutes and
 * loads real models, neither of which unit tests may do.
 */
class FakeChildProcess extends EventEmitter {
  stdout = null
  stderr = null
  unref = vi.fn()
}

/** `SpawnFn`'s type is `child_process.spawn`'s heavily-overloaded signature, which loses
 * `vi.fn`'s `.mock` property the moment it's cast to fit — so tests assert against this
 * plain mock and only cast at the `triggerRun({ spawn })` call site. */
const fakeSpawn = (child: FakeChildProcess) =>
  vi.fn((_command: string, _args: string[], _options: Record<string, unknown>) => child)
const asSpawnFn = (mock: ReturnType<typeof fakeSpawn>) => mock as unknown as SpawnFn

describe('triggerRun', () => {
  let tmpRoot: string

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dashboard-trigger-'))
    process.env.STORAGE_ROOT = tmpRoot
    process.env.REPO_ROOT = '/repo'
  })

  afterEach(async () => {
    delete process.env.STORAGE_ROOT
    delete process.env.REPO_ROOT
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  it('shells out to the exact command a person runs by hand, not a reimplementation', async () => {
    const fake = new FakeChildProcess()
    const spawnMock = fakeSpawn(fake)
    const spawn = asSpawnFn(spawnMock)

    const resultPromise = triggerRun({
      spawn,
      now: () => new Date('2026-08-05T00:00:00.000Z'),
      randomSuffix: () => 'abcd',
    })
    const result = await resultPromise

    expect(result.runId).toBe(`run-${new Date('2026-08-05T00:00:00.000Z').getTime().toString(36)}-abcd`)
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [command, args, options] = spawnMock.mock.calls[0]!
    expect(command).toBe('pnpm')
    expect(args).toEqual(['run', 'pipeline:run', result.runId])
    expect(options).toMatchObject({ cwd: '/repo', detached: true })
  })

  it('forwards DATABASE_URL and STORAGE_ROOT so the spawned process writes where the dashboard reads', async () => {
    process.env.DATABASE_URL = 'file:/somewhere/factory.db'
    const fake = new FakeChildProcess()
    const spawnMock = fakeSpawn(fake)
    const spawn = asSpawnFn(spawnMock)

    await triggerRun({ spawn })

    const options = spawnMock.mock.calls[0]![2] as { env: Record<string, string> }
    expect(options.env.DATABASE_URL).toBe('file:/somewhere/factory.db')
    expect(options.env.STORAGE_ROOT).toBe(tmpRoot)
    delete process.env.DATABASE_URL
  })

  it('unrefs the child so it outlives the request without keeping the dashboard alive', async () => {
    const fake = new FakeChildProcess()
    const spawnMock = fakeSpawn(fake)
    const spawn = asSpawnFn(spawnMock)

    await triggerRun({ spawn })

    expect(fake.unref).toHaveBeenCalledTimes(1)
  })

  it('creates the run directory and a status file before the child even starts', async () => {
    const fake = new FakeChildProcess()
    const spawnMock = fakeSpawn(fake)
    const spawn = asSpawnFn(spawnMock)

    const result = await triggerRun({ spawn })

    const raw = await fs.readFile(result.statusPath, 'utf8')
    const status = JSON.parse(raw) as Record<string, unknown>
    expect(status.runId).toBe(result.runId)
    expect(status.command).toBe('pnpm run pipeline:run')
  })

  it('records a failure to even start the process, so a missing pnpm on PATH is visible', async () => {
    const fake = new FakeChildProcess()
    const spawnMock = fakeSpawn(fake)
    const spawn = asSpawnFn(spawnMock)

    const result = await triggerRun({ spawn })
    fake.emit('error', new Error('spawn pnpm ENOENT'))
    // The handler writes the file asynchronously; give the microtask queue a turn.
    await new Promise((r) => setTimeout(r, 10))

    const status = JSON.parse(await fs.readFile(result.statusPath, 'utf8')) as Record<string, unknown>
    expect(status.failedToStart).toBe(true)
    expect(status.error).toContain('ENOENT')
  })

  it('records the exit code once the pipeline process finishes', async () => {
    const fake = new FakeChildProcess()
    const spawnMock = fakeSpawn(fake)
    const spawn = asSpawnFn(spawnMock)

    const result = await triggerRun({ spawn })
    fake.emit('exit', 1, null)
    await new Promise((r) => setTimeout(r, 10))

    const status = JSON.parse(await fs.readFile(result.statusPath, 'utf8')) as Record<string, unknown>
    expect(status.exitCode).toBe(1)
  })

  it('generates a distinct run id on every call', async () => {
    const spawn = vi.fn(() => new FakeChildProcess()) as unknown as SpawnFn
    const a = await triggerRun({ spawn })
    const b = await triggerRun({ spawn })
    expect(a.runId).not.toBe(b.runId)
  })
})
