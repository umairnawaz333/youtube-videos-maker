import { describe, expect, it } from 'vitest'
import { buildDefaultChecks, runDoctor, type CommandRunner, type FsProbe } from '@yt/pipeline'

const cmd = (present: string[]): CommandRunner => ({
  async which(bin) {
    return present.includes(bin) ? `/usr/local/bin/${bin}` : null
  },
})

const probe = (
  existing: string[],
  free = 100 * 1024 ** 3,
  options: { executable?: string[]; nonEmpty?: string[]; containsText?: string[] } = {},
): FsProbe => ({
  async exists(p) {
    return existing.some((e) => p.endsWith(e))
  },
  async freeBytes() {
    return free
  },
  async isExecutable(p) {
    const executable = options.executable ?? existing
    return executable.some((e) => p.endsWith(e))
  },
  async hasEntries(p) {
    const nonEmpty = options.nonEmpty ?? existing
    return nonEmpty.some((e) => p.endsWith(e))
  },
  async containsText(p) {
    const withText = options.containsText ?? existing
    return withText.some((e) => p.endsWith(e))
  },
})

// A fetchImpl fake that answers /api/tags and /api/generate as if a healthy server were
// listening — used so tests that don't care about the model-server check still get a PASS.
const okFetch: typeof fetch = (async () =>
  new Response(JSON.stringify({ response: 'OK' }), { status: 200 })) as typeof fetch

// The default for tests that don't care about the model-server check at all: fails fast
// with no real network call (the check is optional, so this never fails the whole report).
const unreachableFetch: typeof fetch = (async () => {
  throw new Error('connect ECONNREFUSED 127.0.0.1:11434')
}) as typeof fetch

const allPresent = () =>
  buildDefaultChecks({
    cmd: cmd(['ffmpeg', 'whisper-cli', 'node', 'python3']),
    fs: probe([
      'bin/ollama',
      'models/ollama',
      'models/hf',
      'models/tts',
      'models/whisper',
      '.env',
      'storage/factory.db',
    ]),
    repoRoot: '/repo',
    env: {},
    fetchImpl: okFetch,
  })

describe('doctor', () => {
  it('passes when every dependency is present', async () => {
    const report = await runDoctor(allPresent())
    expect(report.ok).toBe(true)
    expect(report.results.every((r) => r.ok)).toBe(true)
  })

  it('fails when ffmpeg is missing', async () => {
    const checks = buildDefaultChecks({
      cmd: cmd(['whisper-cli', 'node', 'python3']),
      fs: probe(['bin/ollama']),
      repoRoot: '/repo',
      env: {},
      fetchImpl: unreachableFetch,
    })
    const report = await runDoctor(checks)

    expect(report.ok).toBe(false)
    expect(report.results.find((r) => r.name === 'ffmpeg')).toMatchObject({ ok: false })
  })

  it('fails when the in-repo ollama binary is absent', async () => {
    const checks = buildDefaultChecks({
      cmd: cmd(['ffmpeg', 'whisper-cli', 'node', 'python3']),
      fs: probe([]),
      repoRoot: '/repo',
      env: {},
      fetchImpl: unreachableFetch,
    })
    const report = await runDoctor(checks)

    expect(report.results.find((r) => r.name === 'ollama binary')).toMatchObject({ ok: false })
  })

  it('reports missing model directories without failing the whole report', async () => {
    const checks = buildDefaultChecks({
      cmd: cmd(['ffmpeg', 'whisper-cli', 'node', 'python3']),
      fs: probe(['bin/ollama']),
      repoRoot: '/repo',
      env: {},
      fetchImpl: unreachableFetch,
    })
    const report = await runDoctor(checks)

    const weights = report.results.find((r) => r.name === 'SDXL weights')
    expect(weights).toMatchObject({ ok: false, required: false })
  })

  it('fails when free disk space is below twenty gigabytes', async () => {
    const checks = buildDefaultChecks({
      cmd: cmd(['ffmpeg', 'whisper-cli', 'node', 'python3']),
      fs: probe(['bin/ollama', 'models/ollama', 'models/hf', 'models/tts', 'models/whisper'], 5 * 1024 ** 3),
      repoRoot: '/repo',
      env: {},
      fetchImpl: unreachableFetch,
    })
    const report = await runDoctor(checks)

    expect(report.results.find((r) => r.name === 'disk space')).toMatchObject({ ok: false })
    expect(report.ok).toBe(false)
  })

  it('surfaces a thrown check as a failure rather than crashing', async () => {
    const report = await runDoctor([
      {
        name: 'explodes',
        required: true,
        run: async () => {
          throw new Error('permission denied')
        },
      },
    ])

    expect(report.ok).toBe(false)
    expect(report.results[0]!.detail).toContain('permission denied')
  })

  it('ignores optional failures when deciding overall status', async () => {
    const report = await runDoctor([
      { name: 'required-ok', required: true, run: async () => ({ ok: true, detail: 'fine' }) },
      { name: 'optional-bad', required: false, run: async () => ({ ok: false, detail: 'absent' }) },
    ])

    expect(report.ok).toBe(true)
  })

  it('fails when the ollama binary exists but is not executable', async () => {
    const checks = buildDefaultChecks({
      cmd: cmd(['ffmpeg', 'whisper-cli', 'node', 'python3']),
      fs: probe(['bin/ollama'], undefined, { executable: [] }),
      repoRoot: '/repo',
      env: {},
      fetchImpl: unreachableFetch,
    })
    const report = await runDoctor(checks)

    const ollama = report.results.find((r) => r.name === 'ollama binary')
    expect(ollama).toMatchObject({ ok: false, required: true })
    expect(ollama?.detail).toContain('chmod +x')
    // The whole point of this fix: a present-but-broken required check must fail the report.
    expect(report.ok).toBe(false)
  })

  it('passes the ollama binary check when the binary exists and is executable', async () => {
    const checks = buildDefaultChecks({
      cmd: cmd(['ffmpeg', 'whisper-cli', 'node', 'python3']),
      fs: probe([
        'bin/ollama',
        'models/ollama',
        'models/hf',
        'models/tts',
        'models/whisper',
        '.env',
        'storage/factory.db',
      ]),
      repoRoot: '/repo',
      env: {},
      fetchImpl: unreachableFetch,
    })
    const report = await runDoctor(checks)

    expect(report.results.find((r) => r.name === 'ollama binary')).toMatchObject({ ok: true })
    expect(report.ok).toBe(true)
  })

  it('warns without failing the report when a weights directory exists but is empty', async () => {
    const checks = buildDefaultChecks({
      cmd: cmd(['ffmpeg', 'whisper-cli', 'node', 'python3']),
      fs: probe(['bin/ollama', 'models/hf', '.env', 'storage/factory.db'], undefined, {
        nonEmpty: ['bin/ollama'],
      }),
      repoRoot: '/repo',
      env: {},
      fetchImpl: unreachableFetch,
    })
    const report = await runDoctor(checks)

    const weights = report.results.find((r) => r.name === 'SDXL weights')
    expect(weights).toMatchObject({ ok: false, required: false })
    expect(weights?.detail).toMatch(/empty/i)
    // Optional check: must warn, but must not drag the overall report down.
    expect(report.ok).toBe(true)
  })

  it('fails when .env is missing', async () => {
    const checks = buildDefaultChecks({
      cmd: cmd(['ffmpeg', 'whisper-cli', 'node', 'python3']),
      fs: probe(['bin/ollama', 'models/ollama', 'models/hf', 'models/tts', 'models/whisper', 'storage/factory.db']),
      repoRoot: '/repo',
      env: {},
      fetchImpl: unreachableFetch,
    })
    const report = await runDoctor(checks)

    const envCheck = report.results.find((r) => r.name === '.env file')
    expect(envCheck).toMatchObject({ ok: false, required: true })
    expect(envCheck?.detail).toContain('pnpm db:setup')
    expect(report.ok).toBe(false)
  })

  it('fails when the database file has never been pushed', async () => {
    const checks = buildDefaultChecks({
      cmd: cmd(['ffmpeg', 'whisper-cli', 'node', 'python3']),
      fs: probe(['bin/ollama', 'models/ollama', 'models/hf', 'models/tts', 'models/whisper', '.env']),
      repoRoot: '/repo',
      env: {},
      fetchImpl: unreachableFetch,
    })
    const report = await runDoctor(checks)

    const schema = report.results.find((r) => r.name === 'database schema')
    expect(schema).toMatchObject({ ok: false, required: true })
    expect(schema?.detail).toContain('no database at')
    expect(report.ok).toBe(false)
  })

  it('fails when the database file exists but the schema was never pushed', async () => {
    const checks = buildDefaultChecks({
      cmd: cmd(['ffmpeg', 'whisper-cli', 'node', 'python3']),
      fs: probe(
        ['bin/ollama', 'models/ollama', 'models/hf', 'models/tts', 'models/whisper', '.env', 'storage/factory.db'],
        undefined,
        { containsText: [] },
      ),
      repoRoot: '/repo',
      env: {},
      fetchImpl: unreachableFetch,
    })
    const report = await runDoctor(checks)

    const schema = report.results.find((r) => r.name === 'database schema')
    expect(schema).toMatchObject({ ok: false, required: true })
    expect(schema?.detail).toContain('no Run table')
    expect(report.ok).toBe(false)
  })

  it('passes the database schema check once the Run table has been pushed', async () => {
    const checks = buildDefaultChecks({
      cmd: cmd(['ffmpeg', 'whisper-cli', 'node', 'python3']),
      fs: probe(['bin/ollama', 'models/ollama', 'models/hf', 'models/tts', 'models/whisper', '.env', 'storage/factory.db']),
      repoRoot: '/repo',
      env: {},
      fetchImpl: unreachableFetch,
    })
    const report = await runDoctor(checks)

    expect(report.results.find((r) => r.name === 'database schema')).toMatchObject({ ok: true })
  })

  it('warns without failing the report when the model server is unreachable', async () => {
    const checks = buildDefaultChecks({
      cmd: cmd(['ffmpeg', 'whisper-cli', 'node', 'python3']),
      fs: probe(['bin/ollama', 'models/ollama', 'models/hf', 'models/tts', 'models/whisper', '.env', 'storage/factory.db']),
      repoRoot: '/repo',
      env: {},
      fetchImpl: unreachableFetch,
    })
    const report = await runDoctor(checks)

    const server = report.results.find((r) => r.name === 'model server')
    expect(server).toMatchObject({ ok: false, required: false })
    expect(server?.detail).toContain("pnpm ollama:serve")
    expect(report.ok).toBe(true)
  })

  it('warns — but does not fail the report — when /api/tags answers but /api/generate cannot serve the model', async () => {
    // This is the exact bug that motivated the check: the server looks healthy (tags list
    // the model) while the model root has moved out from under it, so generation 404s.
    const flakyFetch: typeof fetch = (async (url: string | URL) => {
      const href = url.toString()
      if (href.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }), { status: 200 })
      }
      return new Response('model not found', { status: 404, statusText: 'Not Found' })
    }) as typeof fetch

    const checks = buildDefaultChecks({
      cmd: cmd(['ffmpeg', 'whisper-cli', 'node', 'python3']),
      fs: probe(['bin/ollama', 'models/ollama', 'models/hf', 'models/tts', 'models/whisper', '.env', 'storage/factory.db']),
      repoRoot: '/repo',
      env: {},
      fetchImpl: flakyFetch,
    })
    const report = await runDoctor(checks)

    const server = report.results.find((r) => r.name === 'model server')
    expect(server).toMatchObject({ ok: false, required: false })
    expect(server?.detail).toContain('/api/tags')
    expect(server?.detail).toContain('/api/generate')
    expect(report.ok).toBe(true)
  })

  it('passes the model server check when both /api/tags and /api/generate succeed', async () => {
    const checks = buildDefaultChecks({
      cmd: cmd(['ffmpeg', 'whisper-cli', 'node', 'python3']),
      fs: probe(['bin/ollama', 'models/ollama', 'models/hf', 'models/tts', 'models/whisper', '.env', 'storage/factory.db']),
      repoRoot: '/repo',
      env: {},
      fetchImpl: okFetch,
    })
    const report = await runDoctor(checks)

    expect(report.results.find((r) => r.name === 'model server')).toMatchObject({ ok: true })
  })
})
