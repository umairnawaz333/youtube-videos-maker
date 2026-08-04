import { STAGE_REQUIREMENTS, type Stage, type StageName, type StageOutcome } from '@yt/core'

export interface FakeStageOptions {
  outcome?: StageOutcome
  /** Throw on the first N invocations, then succeed. Exercises retry behaviour. */
  failTimes?: number
  onRun?: (name: StageName) => void
}

export const fakeStage = (name: StageName, opts: FakeStageOptions = {}): Stage => {
  let invocations = 0
  return {
    name,
    requires: STAGE_REQUIREMENTS[name],
    async run() {
      invocations += 1
      opts.onRun?.(name)
      if (opts.failTimes && invocations <= opts.failTimes) {
        throw new Error(`${name} failed on attempt ${invocations}`)
      }
      return opts.outcome ?? { status: 'done' }
    },
  }
}
