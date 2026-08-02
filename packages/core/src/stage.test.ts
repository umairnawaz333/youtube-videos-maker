import { describe, expect, it, vi } from 'vitest'
import { STAGE_REQUIREMENTS, type Stage, type StageOutcome, type RunContext } from '@yt/core'

/** A stage is only its name, its model requirement, and a run function. */
const buildStage = (outcome: StageOutcome): Stage => ({
  name: 'clip-gate',
  requires: STAGE_REQUIREMENTS['clip-gate'],
  run: vi.fn(async () => outcome),
})

describe('Stage contract', () => {
  it('lets a stage report completion', async () => {
    const stage = buildStage({ status: 'done' })
    await expect(stage.run({} as RunContext)).resolves.toEqual({ status: 'done' })
  })

  it('lets a stage pause the run for human input', async () => {
    const stage = buildStage({ status: 'paused', reason: 'awaiting_clips' })
    await expect(stage.run({} as RunContext)).resolves.toEqual({
      status: 'paused',
      reason: 'awaiting_clips',
    })
  })

  it('declares the clip gate as needing no model memory', () => {
    expect(buildStage({ status: 'done' }).requires).toBe('none')
  })
})
