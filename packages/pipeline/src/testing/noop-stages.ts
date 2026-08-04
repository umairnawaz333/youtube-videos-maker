import { STAGE_NAMES, STAGE_REQUIREMENTS, type Stage } from '@yt/core'

/**
 * Placeholder stages that satisfy the Stage contract without doing real work.
 * Replaced stage-by-stage in Plans 2-4. Kept in src (not test) so the CLI can run
 * a smoke pipeline before any real provider exists.
 */
export const buildNoopStages = (): Stage[] =>
  STAGE_NAMES.map((name) => ({
    name,
    requires: STAGE_REQUIREMENTS[name],
    async run(ctx) {
      ctx.log.info(`noop ${name}`, { stage: name })
      return { status: 'done' as const }
    },
  }))
