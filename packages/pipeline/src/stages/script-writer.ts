import {
  ResearchSchema,
  ScriptSchema,
  SECTION_KINDS,
  STAGE_REQUIREMENTS,
  TopicSchema,
  type Stage,
} from '@yt/core'
import { buildScriptPrompt, SECONDS_PER_BEAT_HINT } from './prompts/script-writer'

export const createScriptWriterStage = (): Stage => ({
  name: 'script-writer',
  requires: STAGE_REQUIREMENTS['script-writer'],

  async run(ctx) {
    const topic = await ctx.artifacts.read('topic', TopicSchema)
    const research = await ctx.artifacts.read('research', ResearchSchema)

    // Spec: "Total word count derives from duration x 150 wpm." Shorts ignore the operator's
    // configured `duration` entirely and target the preset window's midpoint, since the preset
    // is what the eight-section, 15-30s-beat schema can actually carry for that format and the
    // config value has no guaranteed relationship to it. Long-form IS driven by `duration`
    // (configured in minutes, converted to seconds), clamped into the preset's own min/max so an
    // out-of-range value can't push the stated target outside what the schema can carry.
    const { minDurationSec, maxDurationSec } = ctx.config.preset
    const targetSeconds =
      ctx.config.videoType === 'shorts'
        ? Math.round((minDurationSec + maxDurationSec) / 2)
        : Math.min(maxDurationSec, Math.max(minDurationSec, Math.round(ctx.config.duration * 60)))

    // Beats-per-section is derived from the same per-beat seconds hint the prompt uses for its
    // word-count instruction (not a separate, disconnected constant), so the stated word target
    // and the beat budget the model is asked to hit can never drift apart. Within the long
    // preset's 480-600s window every in-range duration resolves to the same 3 beats/section
    // (24 beats total x 22s/beat = 528s, inside the window) -- duration changes the stated
    // target seconds and word count, not the beat structure. See batch-c-fixes-report for the
    // full sweep.
    const beatsPerSection = Math.max(
      1,
      Math.round(targetSeconds / (SECONDS_PER_BEAT_HINT * SECTION_KINDS.length)),
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
