import {
  ResearchSchema,
  ScriptSchema,
  SECTION_KINDS,
  STAGE_REQUIREMENTS,
  TopicSchema,
  type Stage,
} from '@yt/core'
import { buildScriptPrompt } from './prompts/script-writer'

/** Midpoint of the schema-permitted 15-30s beat window. */
const SECONDS_PER_BEAT = 25

export const createScriptWriterStage = (): Stage => ({
  name: 'script-writer',
  requires: STAGE_REQUIREMENTS['script-writer'],

  async run(ctx) {
    const topic = await ctx.artifacts.read('topic', TopicSchema)
    const research = await ctx.artifacts.read('research', ResearchSchema)

    // Spec section 4 stage 3 derives the beat budget from the format preset's duration window,
    // not from the operator's configured `duration` figure: the preset is what the eight-
    // section, 15-30s-beat schema can actually carry, and the config value has no guaranteed
    // relationship to it (shorts ignores it entirely; long-form can be set outside the preset's
    // own min/max). Target the midpoint of the preset window.
    const { minDurationSec, maxDurationSec } = ctx.config.preset
    const targetSeconds = Math.round((minDurationSec + maxDurationSec) / 2)
    const beatsPerSection = Math.max(
      1,
      Math.round(targetSeconds / (SECONDS_PER_BEAT * SECTION_KINDS.length)),
    )

    ctx.log.info(
      `writing a ~${targetSeconds}s script: ${beatsPerSection} beats per section across ${SECTION_KINDS.length} sections`,
    )

    const script = await ctx.providers.llm.json(
      buildScriptPrompt({
        topicTitle: topic.title,
        angle: topic.angle,
        facts: research.facts.map((f) => f.text),
        targetSeconds,
        beatsPerSection,
      }),
      'Script',
      // No clamping: a beat outside the schema's 15-30s window must fail validation so the
      // provider's JSON retry loop re-asks. Silently rewriting an out-of-range value would
      // relax the schema to accommodate the model, which this stage must not do.
      (raw) => ScriptSchema.parse(raw),
    )

    await ctx.artifacts.write('script', ScriptSchema, script)

    const beats = script.sections.flatMap((s) => s.beats)
    const total = beats.reduce((sum, b) => sum + b.targetSeconds, 0)
    ctx.log.info(`wrote ${beats.length} beats totalling ~${total}s`)
    return { status: 'done' }
  },
})
