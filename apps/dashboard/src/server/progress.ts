import { STAGE_NAMES, type RunStatus, type StageName } from '@yt/core'
import type { StageRecord } from '@yt/db'

export type StageDisplayStatus = 'pending' | 'running' | 'done' | 'halted'

export interface StageProgress {
  name: StageName
  status: StageDisplayStatus
  attempts: number
  /**
   * The stage's own halt/error message, verbatim. This is deliberately never summarised or
   * replaced with a generic "failed" label — the quality gate and fact-checker exist
   * specifically to produce a human-readable reason, and that reason is the whole point of
   * surfacing it here.
   */
  reason: string | null
}

export interface RunProgress {
  stages: StageProgress[]
  /** The single stage the run stopped on, if it stopped on a failure/halt. */
  haltedStage: StageProgress | null
}

/**
 * Merges the canonical 14-stage order (`@yt/core` `STAGE_NAMES`) with whatever `StageRun` rows
 * actually exist for this run. A stage the runner hasn't reached yet has no row at all, so it
 * is reported as `pending` rather than omitted — the dashboard always shows all 14 stages.
 */
export const buildRunProgress = (records: StageRecord[]): RunProgress => {
  const byName = new Map(records.map((r) => [r.name, r]))

  const stages: StageProgress[] = STAGE_NAMES.map((name) => {
    const record = byName.get(name)
    if (!record) return { name, status: 'pending', attempts: 0, reason: null }

    const status: StageDisplayStatus =
      record.status === 'failed' ? 'halted' : record.status === 'running' ? 'running' : 'done'

    return { name, status, attempts: record.attempts, reason: record.error }
  })

  const haltedStage = stages.find((s) => s.status === 'halted') ?? null

  return { stages, haltedStage }
}

/** A short, human phrase for the run's own status column (the runs list, run header, etc). */
export const describeRunStatus = (status: RunStatus): string => {
  switch (status) {
    case 'queued':
      return 'Queued'
    case 'running':
      return 'Running'
    case 'awaiting_clips':
      return 'Awaiting clips'
    case 'awaiting_review':
      return 'Awaiting review'
    case 'failed':
      return 'Halted'
    case 'published':
      return 'Published'
    default:
      return status
  }
}
