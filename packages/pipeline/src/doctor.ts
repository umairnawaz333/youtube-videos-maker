import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
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
  /** True only if `p` exists and has the executable bit set for this process. */
  isExecutable(p: string): Promise<boolean>
  /** True only if `p` exists, is readable, and contains at least one entry. */
  hasEntries(p: string): Promise<boolean>
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

  const ollamaBinary = (): DoctorCheck => {
    const target = path.join(repoRoot, 'bin/ollama')
    return {
      name: 'ollama binary',
      required: true,
      run: async () => {
        const present = await fs.exists(target)
        if (!present) {
          return {
            ok: false,
            detail: `missing ${target} — install the ollama binary into the repo`,
          }
        }
        const executable = await fs.isExecutable(target)
        if (!executable) {
          return {
            ok: false,
            detail: `${target} exists but is not executable — run chmod +x ${target}`,
          }
        }
        return { ok: true, detail: target }
      },
    }
  }

  const weightDir = (relative: string, name: string): DoctorCheck => {
    const target = path.join(repoRoot, relative)
    return {
      name,
      required: false,
      run: async () => {
        const present = await fs.exists(target)
        if (!present) {
          return { ok: false, detail: `${name} not found at ${target} — not set up yet` }
        }
        const nonEmpty = await fs.hasEntries(target)
        if (!nonEmpty) {
          return {
            ok: false,
            detail: `${name} directory ${target} is empty — download may have been interrupted`,
          }
        }
        return { ok: true, detail: target }
      },
    }
  }

  return [
    binary('node'),
    binary('python3'),
    binary('ffmpeg'),
    binary('whisper-cli'),
    ollamaBinary(),
    weightDir('models/ollama', 'LLM weights'),
    weightDir('models/hf', 'SDXL weights'),
    weightDir('models/tts', 'TTS voice'),
    weightDir('models/whisper', 'whisper model'),
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
  async isExecutable(p) {
    try {
      await fsp.access(p, constants.X_OK)
      return true
    } catch {
      return false
    }
  },
  async hasEntries(p) {
    try {
      const entries = await fsp.readdir(p)
      return entries.length > 0
    } catch {
      return false
    }
  },
})
