import {
  ScenePlanSchema,
  ScriptSchema,
  STAGE_REQUIREMENTS,
  type Scene,
  type SceneVisual,
  type Stage,
} from '@yt/core'
import { buildScenePlanPrompt } from './prompts/scene-planner'

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

    const plan = await ctx.providers.llm.json(
      buildScenePlanPrompt({
        beats,
        styleSuffix: ctx.config.nicheConfig.styleSuffix,
        imageBudget: preset.imageBudget,
        clipBudget,
        clipSections: [...clipSections],
      }),
      'ScenePlan',
      (raw) => ScenePlanSchema.parse(raw),
    )

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
