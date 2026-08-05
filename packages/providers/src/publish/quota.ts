import fs from 'node:fs/promises'
import path from 'node:path'

/** Cost of one `videos.insert` call against an unaudited (non-verified) OAuth app's quota. */
export const YOUTUBE_UPLOAD_COST_UNITS = 1600
/** Daily quota granted to a new, unaudited Google Cloud project. */
export const YOUTUBE_DAILY_QUOTA_UNITS = 10_000
/** Spec section 14: 10,000 / 1,600 caps an unaudited project at roughly six uploads/day. */
export const YOUTUBE_MAX_UPLOADS_PER_DAY = Math.floor(YOUTUBE_DAILY_QUOTA_UNITS / YOUTUBE_UPLOAD_COST_UNITS)

export interface QuotaStatus {
  uploadsToday: number
  /** True once `uploadsToday` has reached the estimated daily cap. Not enforced (YouTube's own
   * quota check is the real backstop) — this is purely so the operator finds out from a log
   * line instead of a mysterious 403 the next time they try to publish. */
  nearOrOverLimit: boolean
}

export interface QuotaTracker {
  /** Call once per successful upload. Persists across process restarts via `statePath`. */
  recordUpload(): Promise<QuotaStatus>
}

interface QuotaState {
  date: string // YYYY-MM-DD, UTC
  uploads: number
}

const dayKey = (d: Date): string => d.toISOString().slice(0, 10)

const readState = async (statePath: string): Promise<QuotaState | null> => {
  try {
    const raw = await fs.readFile(statePath, 'utf8')
    return JSON.parse(raw) as QuotaState
  } catch {
    return null
  }
}

/**
 * Tracks how many uploads have happened today against a small JSON file (not a database — this
 * is advisory bookkeeping, not the run ledger), so throughput guidance survives a restart of
 * the process between runs, not just within one.
 */
export const createQuotaTracker = (opts: { statePath: string; now?: () => Date }): QuotaTracker => {
  const now = opts.now ?? (() => new Date())

  return {
    async recordUpload() {
      const today = dayKey(now())
      const existing = await readState(opts.statePath)
      const uploads = existing && existing.date === today ? existing.uploads + 1 : 1

      await fs.mkdir(path.dirname(opts.statePath), { recursive: true })
      await fs.writeFile(opts.statePath, JSON.stringify({ date: today, uploads } satisfies QuotaState), 'utf8')

      return { uploadsToday: uploads, nearOrOverLimit: uploads >= YOUTUBE_MAX_UPLOADS_PER_DAY }
    },
  }
}
