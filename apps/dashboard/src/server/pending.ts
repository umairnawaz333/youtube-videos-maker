import fs from 'node:fs/promises'
import path from 'node:path'
import { pathsForRun } from './artifacts'

/**
 * Covers the gap between "Generate was clicked" and "the pipeline's own first database
 * write": `triggerRun` writes `pipeline.status.json` and streams the child's output to
 * `pipeline.log` before the spawned CLI process ever touches the `Run` table (and if the
 * model server is unreachable, the CLI's own health check exits before it ever does — see
 * `packages/pipeline/src/cli.ts`'s `run` verb). Without this, that failure mode shows up as a
 * run page for a run that, as far as the database is concerned, never existed.
 */
export interface PendingRunInfo {
  /** Whether the trigger seam left any trace at all for this run id. */
  found: boolean
  failedToStart: boolean
  exitCode: number | null
  logTail: string | null
}

const TAIL_LINES = 40

export const readPendingRunInfo = async (runId: string): Promise<PendingRunInfo> => {
  const root = pathsForRun(runId).root
  const statusPath = path.join(root, 'pipeline.status.json')
  const logPath = path.join(root, 'pipeline.log')

  let status: Record<string, unknown> | null = null
  try {
    status = JSON.parse(await fs.readFile(statusPath, 'utf8')) as Record<string, unknown>
  } catch {
    status = null
  }

  let logTail: string | null = null
  try {
    const log = await fs.readFile(logPath, 'utf8')
    logTail = log.split('\n').slice(-TAIL_LINES).join('\n')
  } catch {
    logTail = null
  }

  return {
    found: status !== null || logTail !== null,
    failedToStart: Boolean(status?.failedToStart),
    exitCode: typeof status?.exitCode === 'number' ? (status.exitCode as number) : null,
    logTail,
  }
}
