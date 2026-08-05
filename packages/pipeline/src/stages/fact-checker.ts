import { z } from 'zod'
import {
  FactCheckSchema,
  MAX_FAILURE_RATIO,
  ResearchSchema,
  ScriptSchema,
  STAGE_REQUIREMENTS,
  type Stage,
} from '@yt/core'
import { selectFactsForPrompt } from './prompts/facts'
import { buildFactCheckPrompt } from './prompts/fact-checker'

// The model is only ever shown each fact's *text*, never its sourceUrl (see ResearchSchema /
// the prompt), so it cannot be trusted to produce a real URL — asking it to would just invite
// a fabricated citation, which is worse than none for a project whose point is grounding.
// Instead it echoes back the number of the fact it relied on (the prompt numbers facts
// `(1) ... (2) ...`), and we map that index to the fact's real, schema-validated sourceUrl
// ourselves below.

// The model labels every extracted sentence's type; only "factual" is ever scored. This is a
// structural filter, not a sterner instruction: the prompt already told the model in plain
// language that rhetorical questions and opinions are not claims, and a real run extracted them
// anyway — a rhetorical question or narrative aside reported "unsupported" for want of a source
// that could never exist for a sentence asserting nothing. Dropping every non-"factual" type in
// code below survives the model ignoring the instruction in a way the instruction alone did not.
const CLAIM_TYPES = ['factual', 'rhetorical', 'opinion', 'narrative'] as const

const ClaimsSchema = z.object({
  claims: z
    .array(
      z.object({
        text: z.string().min(1),
        type: z.enum(CLAIM_TYPES),
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

    // Must be the exact same slice the script writer's prompt was built from (see
    // selectFactsForPrompt): the writer is only allowed to state what its facts support, so if
    // this stage judged against a different slice, a claim genuinely grounded in a fact outside
    // this stage's view would be marked unsupported through no fault of the narration.
    const promptFacts = selectFactsForPrompt(research.facts, ctx.config.llm.maxFactsPerPrompt)
    if (promptFacts.length < research.facts.length) {
      ctx.log.info(
        `checking against ${promptFacts.length} of ${research.facts.length} gathered facts ` +
          `(capped at maxFactsPerPrompt, same slice the script writer used)`,
      )
    }

    const { claims: extractedClaims } = await ctx.providers.llm.json(
      buildFactCheckPrompt({ beats, facts: promptFacts.map((f) => f.text) }),
      'FactCheckClaims',
      (raw) => ClaimsSchema.parse(raw),
      { temperature: ctx.config.llm.temperature, numCtx: ctx.config.llm.numCtx },
    )

    // Roughly two-thirds of a real run's failures were rhetorical questions, narrative framing,
    // and value statements the model extracted as if they were checkable claims — none of them
    // could ever be "supported" by any corpus, since none of them assert anything a source
    // could confirm. Drop every non-"factual" type before scoring reaches them at all; only a
    // "factual" sentence can fail the corpus, and only a "factual" sentence should be able to.
    const factualClaims = extractedClaims.filter((claim) => claim.type === 'factual')
    const nonFactualDropped = extractedClaims.length - factualClaims.length
    if (nonFactualDropped > 0) {
      ctx.log.info(
        `dropped ${nonFactualDropped} non-factual claim(s) of ${extractedClaims.length} extracted ` +
          `(rhetorical questions, opinions, or narrative framing) before scoring`,
      )
    }

    // A real run extracted the same claim text four times over (17 claims, only 14 distinct),
    // which inflates failureRatio below by counting one real unsupported claim as four —
    // 53% reported instead of the true 43%. Dedupe by normalized text before anything else, so
    // every computation past this point (the ratio, the halt, the written report) sees each
    // distinct claim exactly once, keeping whichever occurrence came first.
    const seenClaimTexts = new Set<string>()
    const rawClaims = factualClaims.filter((claim) => {
      const key = claim.text.trim().toLowerCase().replace(/\s+/g, ' ')
      if (seenClaimTexts.has(key)) return false
      seenClaimTexts.add(key)
      return true
    })
    const duplicatesDropped = factualClaims.length - rawClaims.length
    if (duplicatesDropped > 0) {
      ctx.log.info(
        `dropped ${duplicatesDropped} duplicate claim(s) of ${factualClaims.length} factual claim(s) extracted before scoring`,
      )
    }

    // Map the model's fact number to the real sourceUrl ourselves; never trust a model-typed
    // URL. Only a "supported" claim can carry a citation at all — the prompt tells the model
    // not to cite an unsupported/contradicted claim, but we don't rely on it obeying that; an
    // out-of-range or missing index just means no citation, not a wrong one, and never a reason
    // to change the verdict (a supported claim with a bad index is still supported).
    const claims = rawClaims.map(({ sourceFact, type: _type, ...claim }) => {
      const sourceUrl =
        claim.verdict === 'supported' && sourceFact !== undefined
          ? promptFacts[sourceFact - 1]?.sourceUrl
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
