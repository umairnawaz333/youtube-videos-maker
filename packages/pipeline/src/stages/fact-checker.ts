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

// The model is only ever shown each fact's *text*, never its sourceUrl (see ResearchSchema /
// the prompt), so it cannot be trusted to produce a real URL — asking it to would just invite
// a fabricated citation, which is worse than none for a project whose point is grounding.
// Instead it echoes back the number of the fact it relied on (the prompt numbers facts
// `(1) ... (2) ...`), and we map that index to the fact's real, schema-validated sourceUrl
// ourselves below.
const ClaimsSchema = z.object({
  claims: z
    .array(
      z.object({
        text: z.string().min(1),
        verdict: z.enum(['supported', 'unsupported', 'contradicted']),
        sourceFact: z.number().optional(),
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
    const { claims: extractedClaims } = await ctx.providers.llm.json(
      buildFactCheckPrompt({ beats, facts: research.facts.map((f) => f.text) }),
      'FactCheckClaims',
      (raw) => ClaimsSchema.parse(raw),
      { temperature: ctx.config.llm.temperature },
    )

    // A real run extracted the same claim text four times over (17 claims, only 14 distinct),
    // which inflates failureRatio below by counting one real unsupported claim as four —
    // 53% reported instead of the true 43%. Dedupe by normalized text before anything else, so
    // every computation past this point (the ratio, the halt, the written report) sees each
    // distinct claim exactly once, keeping whichever occurrence came first.
    const seenClaimTexts = new Set<string>()
    const rawClaims = extractedClaims.filter((claim) => {
      const key = claim.text.trim().toLowerCase().replace(/\s+/g, ' ')
      if (seenClaimTexts.has(key)) return false
      seenClaimTexts.add(key)
      return true
    })
    const duplicatesDropped = extractedClaims.length - rawClaims.length
    if (duplicatesDropped > 0) {
      ctx.log.info(
        `dropped ${duplicatesDropped} duplicate claim(s) of ${extractedClaims.length} extracted before scoring`,
      )
    }

    // Map the model's fact number to the real sourceUrl ourselves; never trust a model-typed
    // URL. Only a "supported" claim can carry a citation at all — the prompt tells the model
    // not to cite an unsupported/contradicted claim, but we don't rely on it obeying that; an
    // out-of-range or missing index just means no citation, not a wrong one, and never a reason
    // to change the verdict (a supported claim with a bad index is still supported).
    const claims = rawClaims.map(({ sourceFact, ...claim }) => {
      const sourceUrl =
        claim.verdict === 'supported' && sourceFact !== undefined
          ? research.facts[sourceFact - 1]?.sourceUrl
          : undefined
      return sourceUrl !== undefined ? { ...claim, sourceUrl } : claim
    })

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
