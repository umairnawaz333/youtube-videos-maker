import type { RunLogger } from '@yt/core'

export interface LogEntry {
  runId: string
  level: 'info' | 'warn' | 'error'
  message: string
  meta?: Record<string, unknown>
}

/**
 * Emits structured entries to a sink, which the API layer forwards over SSE so the
 * dashboard shows live progress instead of a spinner. A failing sink must never fail a run.
 */
export class EventRunLogger implements RunLogger {
  constructor(
    private readonly runId: string,
    private readonly sink: (entry: LogEntry) => void,
  ) {}

  private emit(level: LogEntry['level'], message: string, meta?: Record<string, unknown>): void {
    try {
      this.sink({ runId: this.runId, level, message, ...(meta ? { meta } : {}) })
    } catch {
      // Swallowed deliberately: a disconnected log consumer must not abort the pipeline.
    }
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.emit('info', message, meta)
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.emit('warn', message, meta)
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.emit('error', message, meta)
  }
}
