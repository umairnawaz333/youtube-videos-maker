import path from 'node:path'
import { STAGE_REQUIREMENTS, ScenePlanSchema, type Stage } from '@yt/core'
import { deriveBaseSeed, SDXL_IMAGE_SIZE } from './prompts/illustrator'
import { buildHeroPrompt } from './prompts/thumbnailer'
import { generateImageWithRetry, isSdImageScene } from './illustrator'

/** Five candidates, exactly as the storage layout in the design spec names them
 * (`thumbnail/v1..v5.png`). Text overlay compositing is the render block's job, not this
 * stage's — these are backgrounds only. */
const CANDIDATE_COUNT = 5

/** Offset from the illustrator's own base seed so a hero candidate that reuses a scene's prompt
 * does not just reproduce that scene's exact illustrator image. */
const SEED_OFFSET = 97

export const createThumbnailerStage = (): Stage => ({
  name: 'thumbnailer',
  requires: STAGE_REQUIREMENTS.thumbnailer,

  async run(ctx) {
    const plan = await ctx.artifacts.read('scenes', ScenePlanSchema)
    const imagePrompts = plan.scenes.filter(isSdImageScene).map((s) => s.visual.prompt)

    if (imagePrompts.length === 0) {
      return {
        status: 'halted',
        reason: 'no sd-image scenes are available in the scene plan to build thumbnail candidates from',
      }
    }

    const baseSeed = deriveBaseSeed(ctx.runId) + SEED_OFFSET

    for (let i = 0; i < CANDIDATE_COUNT; i++) {
      // Cycles through the available prompts when there are fewer sd-image scenes than
      // candidates — still five distinct requests, each with its own seed, rather than
      // generating only as many candidates as there happen to be distinct source scenes.
      const scenePrompt = imagePrompts[i % imagePrompts.length]!
      const prompt = buildHeroPrompt(scenePrompt, ctx.config.nicheConfig.styleSuffix)
      const outPath = path.join(ctx.paths.thumbnail, `v${i + 1}.png`)
      await generateImageWithRetry(ctx, {
        prompt,
        width: SDXL_IMAGE_SIZE,
        height: SDXL_IMAGE_SIZE,
        seed: baseSeed + i,
        outPath,
      })
    }

    ctx.log.info(`generated ${CANDIDATE_COUNT} thumbnail hero candidates`)
    return { status: 'done' }
  },
})
