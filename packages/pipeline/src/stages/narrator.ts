import path from 'node:path'
import { ScenePlanSchema, STAGE_REQUIREMENTS, type RunPaths, type Scene, type Stage } from '@yt/core'

/** `audio/scene-NNN.wav`, 1-indexed by the scene's position in the plan — matches the
 * storage layout in the spec (`audio/scene-001.wav …`). Position, not `scene.id`, is used
 * because ids are LLM-generated strings with no guaranteed numbering; the captioner stage
 * (which reads the same files back) imports this so the two can never drift apart. */
export const sceneAudioFileName = (position: number): string => `scene-${String(position).padStart(3, '0')}.wav`

export const sceneAudioPath = (paths: RunPaths, position: number): string =>
  path.join(paths.audio, sceneAudioFileName(position))

/**
 * Narrator: synthesizes one WAV file per scene and writes the MEASURED duration back onto
 * that scene in scenes.json (overwriting the artifact scene-planner wrote). This is the whole
 * point of the stage per spec §4 — "Audio is generated per scene so scene durations are
 * measured rather than estimated, which is what keeps the visuals locked to the narration."
 *
 * `SceneSchema.durationSec` is optional at the type level (populated lazily, by this stage);
 * every scene leaving here successfully has it set. Downstream stages (editor, quality-gate)
 * read the same 'scenes' artifact and see real numbers rather than an LLM's guess.
 */
export const createNarratorStage = (): Stage => ({
  name: 'narrator',
  requires: STAGE_REQUIREMENTS.narrator,

  async run(ctx) {
    const plan = await ctx.artifacts.read('scenes', ScenePlanSchema)

    const measured: Scene[] = []
    for (const [i, scene] of plan.scenes.entries()) {
      const outPath = sceneAudioPath(ctx.paths, i + 1)
      const result = await ctx.providers.tts.speak({
        text: scene.text,
        voice: ctx.config.voice,
        outPath,
      })

      if (!(result.durationSec > 0)) {
        throw new Error(
          `narrator: scene '${scene.id}' produced a non-positive measured duration ` +
            `(${result.durationSec}s) from ${outPath}`,
        )
      }

      measured.push({ ...scene, durationSec: result.durationSec })
    }

    // Written only once, after every scene has succeeded: a failure partway through leaves
    // the original (un-measured) scenes.json untouched, so a retried attempt starts clean
    // rather than resuming from a half-updated artifact.
    await ctx.artifacts.write('scenes', ScenePlanSchema, { scenes: measured })

    const totalSec = measured.reduce((sum, s) => sum + (s.durationSec ?? 0), 0)
    ctx.log.info(`narrated ${measured.length} scenes, ${totalSec.toFixed(1)}s of measured audio total`)

    return { status: 'done' }
  },
})
