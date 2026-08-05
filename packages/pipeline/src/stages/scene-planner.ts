import { z } from 'zod'
import {
  ScenePlanSchema,
  ScriptSchema,
  SceneVisualSchema,
  STAGE_REQUIREMENTS,
  CAMERA_MOVES,
  type Scene,
  type SceneVisual,
  type Stage,
} from '@yt/core'
import { buildScenePlanPrompt } from './prompts/scene-planner'

// "text" is dropped from what the model must supply and copied from the script's own beat
// instead. Requiring the model to echo back every beat's full narration roughly doubles the
// output it has to produce for a long-form video's ~22-scene plan on top of the visual/camera
// choice that is the actual point of this stage — real, unnecessary output length that a local
// model handling a large plan can least afford. The beat text is already known verbatim; there
// is nothing for the model to add by retyping it.
const RawSceneSchema = z.object({
  id: z.string().min(1),
  beatId: z.string().min(1),
  visual: SceneVisualSchema,
  camera: z.enum(CAMERA_MOVES),
})

const RawScenePlanSchema = z.object({
  scenes: z.array(RawSceneSchema).min(1),
})

export const createScenePlannerStage = (): Stage => ({
  name: 'scene-planner',
  requires: STAGE_REQUIREMENTS['scene-planner'],

  async run(ctx) {
    const script = await ctx.artifacts.read('script', ScriptSchema)
    const preset = ctx.config.preset
    const clipBudget = ctx.config.clips.enabled ? ctx.config.clips.budget[preset.format] : 0
    const clipSections = ctx.config.clips.placement as readonly string[]

    const beats = script.sections.flatMap((s) =>
      s.beats.map((b) => ({ id: b.id, text: b.text, sectionKind: s.kind })),
    )
    const sectionOfBeat = new Map(beats.map((b) => [b.id, b.sectionKind]))
    const textOfBeat = new Map(beats.map((b) => [b.id, b.text]))

    const rawPlan = await ctx.providers.llm.json(
      buildScenePlanPrompt({
        beats,
        styleSuffix: ctx.config.nicheConfig.styleSuffix,
        imageBudget: preset.imageBudget,
        clipBudget,
        clipSections: [...clipSections],
      }),
      'ScenePlan',
      (raw) => RawScenePlanSchema.parse(raw),
      { temperature: ctx.config.llm.temperature, numCtx: ctx.config.llm.numCtx },
    )

    const plan = {
      scenes: rawPlan.scenes.map((scene) => ({
        ...scene,
        // Whatever beat this scene claims to be for, its narration comes from the script, not
        // from the model's own retyping of it. An unrecognised beatId (the model naming one
        // that doesn't exist) falls back to an empty string here — the same "not a real beat"
        // problem TopicScout's own offered-candidates filter already guards against — which
        // ScenePlanSchema's `text` min-length-1 requirement then rejects downstream, same as it
        // would have rejected an empty echoed string before this change.
        text: textOfBeat.get(scene.beatId) ?? '',
      })),
    }

    if (plan.scenes.length > preset.maxScenes) {
      return {
        status: 'halted',
        reason: `the plan has ${plan.scenes.length} scenes but the ${preset.format} preset allows at most ${preset.maxScenes}`,
      }
    }

    // A model will not respect the budgets reliably, so enforce them here. Doing it after the
    // fact rather than re-prompting keeps the run cheap and the outcome deterministic.
    let imagesUsed = 0
    let clipsUsed = 0
    let lastImageSceneId: string | null = null
    let downgradedImages = 0
    let downgradedClips = 0

    const scenes: Scene[] = plan.scenes.map((scene) => {
      let visual: SceneVisual = scene.visual

      if (visual.kind === 'veo-clip') {
        const section = sectionOfBeat.get(scene.beatId)
        const allowed = clipsUsed < clipBudget && section !== undefined && clipSections.includes(section)
        if (allowed) {
          clipsUsed += 1
          // A clip must always be able to degrade to an image, or a missing clip blocks the run.
          visual = {
            ...visual,
            fallbackPrompt:
              visual.fallbackPrompt.trim().length > 0
                ? visual.fallbackPrompt
                : `${scene.text} — ${ctx.config.nicheConfig.styleSuffix}`,
          }
        } else {
          downgradedClips += 1
          visual = { kind: 'sd-image', prompt: `${visual.fallbackPrompt || scene.text}, ${ctx.config.nicheConfig.styleSuffix}` }
        }
      }

      if (visual.kind === 'sd-image') {
        if (imagesUsed < preset.imageBudget) {
          imagesUsed += 1
          lastImageSceneId = scene.id
        } else if (lastImageSceneId !== null) {
          downgradedImages += 1
          visual = { kind: 'reuse', sceneId: lastImageSceneId }
        }
        // With no earlier image to reuse, keep it: an over-budget first image is better than
        // a reuse pointing at nothing.
      }

      return { ...scene, visual }
    })

    await ctx.artifacts.write('scenes', ScenePlanSchema, { scenes })

    ctx.log.info(
      `planned ${scenes.length} scenes: ${imagesUsed} images (budget ${preset.imageBudget}), ` +
        `${clipsUsed} clips (budget ${clipBudget}), ${downgradedImages} reused, ${downgradedClips} clips downgraded`,
    )
    return { status: 'done' }
  },
})
