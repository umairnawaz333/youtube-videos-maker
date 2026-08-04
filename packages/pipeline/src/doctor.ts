import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface CommandRunner {
  which(bin: string): Promise<string | null>
}

export interface FsProbe {
  exists(p: string): Promise<boolean>
  freeBytes(p: string): Promise<number>
}

export interface DoctorCheck {
  name: string
  /** Optional checks report status but do not fail the overall report. */
  required: boolean
  run(): Promise<{ ok: boolean; detail: string }>
}

export interface DoctorReport {
  ok: boolean
  results: Array<{ name: string; required: boolean; ok: boolean; detail: string }>
}

/** 20 GB covers the model downloads plus render working space. */
export const MIN_FREE_BYTES = 20 * 1024 ** 3

export const buildDefaultChecks = (deps: {
  cmd: CommandRunner
  fs: FsProbe
  repoRoot: string
}): DoctorCheck[] => {
  const { cmd, fs, repoRoot } = deps

  const binary = (bin: string, required = true): DoctorCheck => ({
    name: bin,
    required,
    run: async () => {
      const found = await cmd.which(bin)
      return found
        ? { ok: true, detail: found }
        : { ok: false, detail: `${bin} not found on PATH` }
    },
  })

  const repoPath = (relative: string, name: string, required: boolean): DoctorCheck => ({
    name,
    required,
    run: async () => {
      const target = path.join(repoRoot, relative)
      const present = await fs.exists(target)
      return present
        ? { ok: true, detail: target }
        : { ok: false, detail: `missing ${target} — run the setup script for this component` }
    },
  })

  return [
    binary('node'),
    binary('python3'),
    binary('ffmpeg'),
    binary('whisper-cli'),
    repoPath('bin/ollama', 'ollama binary', true),
    repoPath('models/ollama', 'LLM weights', false),
    repoPath('models/hf', 'SDXL weights', false),
    repoPath('models/tts', 'TTS voice', false),
    repoPath('models/whisper', 'whisper model', false),
    {
      name: 'disk space',
      required: true,
      run: async () => {
        const free = await fs.freeBytes(repoRoot)
        const gb = (free / 1024 ** 3).toFixed(1)
        return free >= MIN_FREE_BYTES
          ? { ok: true, detail: `${gb} GB free` }
          : { ok: false, detail: `only ${gb} GB free, need at least 20 GB` }
      },
    },
  ]
}

export const runDoctor = async (checks: DoctorCheck[]): Promise<DoctorReport> => {
  const results: DoctorReport['results'] = []

  for (const check of checks) {
    try {
      const outcome = await check.run()
      results.push({ name: check.name, required: check.required, ...outcome })
    } catch (error) {
      results.push({
        name: check.name,
        required: check.required,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { ok: results.every((r) => r.ok || !r.required), results }
}

export const nodeCommandRunner = (): CommandRunner => ({
  async which(bin) {
    try {
      const { stdout } = await execFileAsync('which', [bin])
      const found = stdout.trim()
      return found.length > 0 ? found : null
    } catch {
      return null
    }
  },
})

export const nodeFsProbe = (): FsProbe => ({
  async exists(p) {
    try {
      await fsp.access(p)
      return true
    } catch {
      return false
    }
  },
  async freeBytes(p) {
    const stats = await fsp.statfs(p)
    return Number(stats.bavail) * Number(stats.bsize)
  },
})
