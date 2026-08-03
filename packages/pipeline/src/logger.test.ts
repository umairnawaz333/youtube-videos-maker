import { describe, expect, it, vi } from 'vitest'
import { EventRunLogger, type LogEntry } from '@yt/pipeline'

describe('EventRunLogger', () => {
  it('tags every entry with the run id and level', () => {
    const sink = vi.fn<(entry: LogEntry) => void>()
    const log = new EventRunLogger('run-1', sink)

    log.info('starting', { stage: 'topic-scout' })
    log.warn('slow')
    log.error('failed')

    expect(sink).toHaveBeenCalledTimes(3)
    expect(sink.mock.calls[0]![0]).toMatchObject({
      runId: 'run-1',
      level: 'info',
      message: 'starting',
      meta: { stage: 'topic-scout' },
    })
    expect(sink.mock.calls[1]![0]!.level).toBe('warn')
    expect(sink.mock.calls[2]![0]!.level).toBe('error')
  })

  it('never throws when the sink throws, so logging cannot fail a run', () => {
    const log = new EventRunLogger('run-1', () => {
      throw new Error('SSE client vanished')
    })
    expect(() => log.info('still fine')).not.toThrow()
  })
})
