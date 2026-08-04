import { describe, expect, it } from 'vitest'
import { buildDefaultChecks, runDoctor, type CommandRunner, type FsProbe } from '@yt/pipeline'

const cmd = (present: string[]): CommandRunner => ({
  async which(bin) {
    return present.includes(bin) ? `/usr/local/bin/${bin}` : null
  },
})

const probe = (existing: string[], free = 100 * 1024 ** 3): FsProbe => ({
  async exists(p) {
    return existing.some((e) => p.endsWith(e))
  },
  async freeBytes() {
    return free
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
})
