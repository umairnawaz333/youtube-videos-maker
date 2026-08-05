import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { createHttpOllamaClient } from '@yt/providers'

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
  /**
   * True only if `p` exists and its raw contents contain the literal string `needle`.
   * Used to detect an applied database schema without needing a SQL driver: SQLite stores
   * each table's `CREATE TABLE` statement verbatim in the file, so a plain substring search
   * is enough to tell an unmigrated database file apart from a migrated one.
   */
  containsText(p: string, needle: string): Promise<boolean>
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

/** Resolves DATABASE_URL (relative `file:` URLs are anchored at packages/db/prisma, exactly
 * as Prisma itself resolves them) to the same default cli.ts falls back to when unset. */
export const resolveDatabasePath = (env: NodeJS.ProcessEnv, repoRoot: string): string => {
  const raw = env.DATABASE_URL
  if (!raw) return path.join(repoRoot, 'storage/factory.db')
  const filePath = raw.replace(/^file:/, '')
  return path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot, 'packages/db/prisma', filePath)
}

export const buildDefaultChecks = (deps: {
  cmd: CommandRunner
  fs: FsProbe
  repoRoot: string
  /** Defaults to process.env. Overridable so tests never depend on the real shell environment. */
  env?: NodeJS.ProcessEnv
  /** Defaults to global fetch. Overridable so tests never make a real network call. */
  fetchImpl?: typeof fetch
}): DoctorCheck[] => {
  const { cmd, fs, repoRoot } = deps
  const env = deps.env ?? process.env
  const fetchImpl = deps.fetchImpl ?? fetch

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

  const envFile = (): DoctorCheck => {
    const target = path.join(repoRoot, '.env')
    return {
      name: '.env file',
      required: true,
      run: async () => {
        const present = await fs.exists(target)
        return present
          ? { ok: true, detail: target }
          : {
              ok: false,
              detail: `missing ${target} — run 'pnpm db:setup' to create it from .env.example`,
            }
      },
    }
  }

  const databaseSchema = (): DoctorCheck => {
    const target = resolveDatabasePath(env, repoRoot)
    return {
      name: 'database schema',
      required: true,
      run: async () => {
        const present = await fs.exists(target)
        if (!present) {
          return {
            ok: false,
            detail: `no database at ${target} — run 'pnpm db:setup' to push the schema`,
          }
        }
        const migrated = await fs.containsText(target, 'CREATE TABLE "Run"')
        return migrated
          ? { ok: true, detail: target }
          : {
              ok: false,
              detail: `${target} exists but has no Run table — run 'pnpm db:setup' to push the schema`,
            }
      },
    }
  }

  const modelServer = (): DoctorCheck => {
    const host = (env.OLLAMA_HOST ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')
    const model = env.LLM_MODEL ?? 'qwen3:8b'
    return {
      name: 'model server',
      // Optional: a fresh setup legitimately hasn't started `pnpm ollama:serve` yet.
      required: false,
      run: async () => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 3000)
        let reachable: boolean
        try {
          const res = await fetchImpl(`${host}/api/tags`, { signal: controller.signal })
          reachable = res.ok
        } catch {
          reachable = false
        } finally {
          clearTimeout(timer)
        }
        if (!reachable) {
          return {
            ok: false,
            detail: `${host} is not reachable — start it with 'pnpm ollama:serve'`,
          }
        }

        // /api/tags only lists cached manifests; it can answer even when the server can't
        // actually serve the model (e.g. OLLAMA_MODELS now points at a directory that went
        // away). Only a real /api/generate call catches that, so make one here.
        const client = createHttpOllamaClient({ host, fetchImpl })
        try {
          await client.generate({ model, prompt: 'reply with OK', json: false })
          return { ok: true, detail: `${host} (${model})` }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          return {
            ok: false,
            detail:
              `${host} answers /api/tags but cannot serve /api/generate for '${model}' (${detail}) ` +
              "— the model root may have moved out from under the server; restart 'pnpm ollama:serve'",
          }
        }
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
    envFile(),
    databaseSchema(),
    modelServer(),
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
  async containsText(p, needle) {
    try {
      // 'latin1' maps bytes 1:1 to code points, so a binary SQLite file can be scanned for
      // an embedded ASCII substring without risking a UTF-8 decode error on the binary parts.
      const contents = await fsp.readFile(p, 'latin1')
      return contents.includes(needle)
    } catch {
      return false
    }
  },
})
