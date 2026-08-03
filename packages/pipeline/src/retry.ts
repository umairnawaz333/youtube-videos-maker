import { STAGE_RETRY_KIND, type RetryConfig, type Stage } from '@yt/core'

/** Attempt budget per stage, derived from its retry kind. See spec section 8. */
export const attemptsFor = (stage: Stage, retries: RetryConfig): number =>
  retries[STAGE_RETRY_KIND[stage.name]]
