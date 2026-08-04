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
  options: { executable?: string[]; nonEmpty?: string[] } = {},
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
})

const allPresent = () =>
  buildDefaultChecks({
    cmd: cmd(['ffmpeg', 'whisper-cli', 'node', 'python3']),
    fs: probe(['bin/ollama', 'models/ollama', 'models/hf', 'models/tts', 'models/whisper']),
    repoRoot: '/repo',
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
    })
    const report = await runDoctor(checks)

    expect(report.results.find((r) => r.name === 'ollama binary')).toMatchObject({ ok: false })
  })

  it('reports missing model directories without failing the whole report', async () => {
    const checks = buildDefaultChecks({
      cmd: cmd(['ffmpeg', 'whisper-cli', 'node', 'python3']),
      fs: probe(['bin/ollama']),
      repoRoot: '/repo',
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
      fs: probe(['bin/ollama', 'models/ollama', 'models/hf', 'models/tts', 'models/whisper']),
      repoRoot: '/repo',
    })
    const report = await runDoctor(checks)

    expect(report.results.find((r) => r.name === 'ollama binary')).toMatchObject({ ok: true })
    expect(report.ok).toBe(true)
  })

  it('warns without failing the report when a weights directory exists but is empty', async () => {
    const checks = buildDefaultChecks({
      cmd: cmd(['ffmpeg', 'whisper-cli', 'node', 'python3']),
      fs: probe(['bin/ollama', 'models/hf'], undefined, { nonEmpty: ['bin/ollama'] }),
      repoRoot: '/repo',
    })
    const report = await runDoctor(checks)

    const weights = report.results.find((r) => r.name === 'SDXL weights')
    expect(weights).toMatchObject({ ok: false, required: false })
    expect(weights?.detail).toMatch(/empty/i)
    // Optional check: must warn, but must not drag the overall report down.
    expect(report.ok).toBe(true)
  })
})
