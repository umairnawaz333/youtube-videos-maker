import { z } from 'zod'
import {
  FactCheckSchema,
  MAX_FAILURE_RATIO,
  ResearchSchema,
  ScriptSchema,
  STAGE_REQUIREMENTS,
  type Stage,
} from '@yt/core'
import { buildFactCheckPrompt } from './prompts/fact-checker'

const ClaimsSchema = z.object({
  claims: z
    .array(
      z.object({
        text: z.string().min(1),
        verdict: z.enum(['supported', 'unsupported', 'contradicted']),
        sourceUrl: z.string().url().optional(),
      }),
    )
    .min(1),
})

export const createFactCheckerStage = (): Stage => ({
  name: 'fact-checker',
  requires: STAGE_REQUIREMENTS['fact-checker'],

  async run(ctx) {
    const script = await ctx.artifacts.read('script', ScriptSchema)
    const research = await ctx.artifacts.read('research', ResearchSchema)

    const beats = script.sections.flatMap((s) => s.beats.map((b) => b.text))
    const { claims } = await ctx.providers.llm.json(
      buildFactCheckPrompt({ beats, facts: research.facts.map((f) => f.text) }),
      'FactCheckClaims',
      (raw) => ClaimsSchema.parse(raw),
    )

    const failed = claims.filter((c) => c.verdict !== 'supported').length
    const failureRatio = failed / claims.length

    // Written even when the run halts: the whole point of stopping is that someone can look
    // at what failed.
    await ctx.artifacts.write('factcheck', FactCheckSchema, { claims, failureRatio })

    const percent = Math.round(failureRatio * 100)
    ctx.log.info(`checked ${claims.length} claims; ${failed} not supported (${percent}%)`)

    if (failureRatio > MAX_FAILURE_RATIO) {
      return {
        status: 'halted',
        reason:
          `${failed} of ${claims.length} claims are unsupported or contradicted (${percent}%), ` +
          `above the ${Math.round(MAX_FAILURE_RATIO * 100)}% threshold — the script is not grounded in its sources`,
      }
    }

    return { status: 'done' }
  },
})
