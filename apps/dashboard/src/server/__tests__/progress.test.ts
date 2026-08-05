import { describe, expect, it } from 'vitest'
import type { StageRecord } from '@yt/db'
import { buildRunProgress, describeRunStatus } from '../progress'

describe('buildRunProgress', () => {
  it('reports every one of the 14 canonical stages, even ones with no row yet', () => {
    const progress = buildRunProgress([])
    expect(progress.stages).toHaveLength(14)
    expect(progress.stages.every((s) => s.status === 'pending')).toBe(true)
    expect(progress.haltedStage).toBeNull()
  })

  it('marks a done stage as done and carries its attempt count', () => {
    const records: StageRecord[] = [
      { name: 'topic-scout', status: 'done', attempts: 1, error: null },
    ]
    const progress = buildRunProgress(records)
    const topicScout = progress.stages.find((s) => s.name === 'topic-scout')!
    expect(topicScout.status).toBe('done')
    expect(topicScout.attempts).toBe(1)
  })

  it('marks a running stage as running', () => {
    const records: StageRecord[] = [
      { name: 'researcher', status: 'running', attempts: 2, error: null },
    ]
    const progress = buildRunProgress(records)
    expect(progress.stages.find((s) => s.name === 'researcher')!.status).toBe('running')
  })

  it('surfaces a failed stage as halted with its exact reason, not a generic message', () => {
    const reason = 'more than 15% of claims failed fact-checking (18%)'
    const records: StageRecord[] = [
      { name: 'fact-checker', status: 'failed', attempts: 3, error: reason },
    ]
    const progress = buildRunProgress(records)
    const stage = progress.stages.find((s) => s.name === 'fact-checker')!
    expect(stage.status).toBe('halted')
    expect(stage.reason).toBe(reason)
    expect(progress.haltedStage).toEqual(stage)
  })

  it('preserves stage order regardless of the order records arrive in', () => {
    const records: StageRecord[] = [
      { name: 'seo', status: 'done', attempts: 1, error: null },
      { name: 'topic-scout', status: 'done', attempts: 1, error: null },
    ]
    const progress = buildRunProgress(records)
    expect(progress.stages.map((s) => s.name).slice(0, 2)).toEqual(['topic-scout', 'researcher'])
  })
})

describe('describeRunStatus', () => {
  it('gives a human phrase for every run status', () => {
    expect(describeRunStatus('queued')).toBe('Queued')
    expect(describeRunStatus('running')).toBe('Running')
    expect(describeRunStatus('awaiting_clips')).toBe('Awaiting clips')
    expect(describeRunStatus('awaiting_review')).toBe('Awaiting review')
    expect(describeRunStatus('failed')).toBe('Halted')
    expect(describeRunStatus('published')).toBe('Published')
  })
})
