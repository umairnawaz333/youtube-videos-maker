import fs from 'node:fs/promises'
import path from 'node:path'
import { ScenePlanSchema, STAGE_REQUIREMENTS, type ClipRequestSpec, type Scene, type Stage } from '@yt/core'
import { clipsRootPath, sceneImagePath } from '../render/asset-paths'

interface GateState {
  requestedAt: string
}

const stateFilePath = (paths: Parameters<typeof clipsRootPath>[0]): string =>
  path.join(clipsRootPath(paths), 'gate-state.json')

const readState = async (file: string): Promise<GateState | null> => {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return JSON.parse(raw) as GateState
  } catch {
    return null
  }
}

/**
 * ClipGate (spec section 11). Optional — a no-op when clips are disabled or the plan has no
 * `veo-clip` scenes. Otherwise: on its first run it writes the shot list (via the
 * `ClipProvider`, using each scene's *measured* narration duration since this stage runs
 * after Captioner) and pauses the run at `awaiting_clips`. Every subsequent run collects
 * whatever the owner has supplied, resolving each shot to either a fulfilled clip or — once
 * `clips.waitTimeoutHours` has elapsed — an automatic fallback to the scene's image. A shot
 * that is neither fulfilled nor timed out keeps the run paused rather than guessing.
 */
export const createClipGateStage = (): Stage => ({
  name: 'clip-gate',
  requires: STAGE_REQUIREMENTS['clip-gate'],

  async run(ctx) {
    if (!ctx.config.clips.enabled) {
      ctx.log.info('clips disabled, skipping clip gate', { stage: 'clip-gate' })
      return { status: 'done' }
    }

    const plan = await ctx.artifacts.read('scenes', ScenePlanSchema)
    const clipScenes = plan.scenes.filter((s) => s.visual.kind === 'veo-clip')
    if (clipScenes.length === 0) {
      ctx.log.info('no veo-clip scenes in the plan, skipping clip gate', { stage: 'clip-gate' })
      return { status: 'done' }
    }

    for (const scene of clipScenes) {
      if (scene.durationSec === undefined) {
        return {
          status: 'halted',
          reason: `scene '${scene.id}' has no measured duration yet; ClipGate must run after the narrator`,
        }
      }
    }

    const aspectRatio = ctx.config.preset.format === 'shorts' ? ('9:16' as const) : ('16:9' as const)
    const specs: ClipRequestSpec[] = clipScenes.map((scene) => {
      const visual = scene.visual as Extract<Scene['visual'], { kind: 'veo-clip' }>
      return {
        sceneId: scene.id,
        prompt: visual.prompt,
        referenceImagePath: sceneImagePath(ctx.paths, visual.referenceSceneId),
        targetSeconds: scene.durationSec as number,
        aspectRatio,
      }
    })

    const stateFile = stateFilePath(ctx.paths)
    const state = await readState(stateFile)

    if (!state) {
      // First pass: persist for the dashboard, record when we asked, and ask the human.
      await ctx.clipRequests.create(
        ctx.runId,
        specs.map((s) => ({
          sceneId: s.sceneId,
          prompt: s.prompt,
          referenceImagePath: s.referenceImagePath,
          targetSeconds: s.targetSeconds,
        })),
      )
      await fs.mkdir(path.dirname(stateFile), { recursive: true })
      const requestedAt = ctx.clock.now().toISOString()
      await fs.writeFile(stateFile, JSON.stringify({ requestedAt }), 'utf8')

      const result = await ctx.providers.clip.request(specs)
      if (result.status === 'paused') {
        ctx.log.info(`clip gate paused: requested ${specs.length} shot(s)`, { stage: 'clip-gate' })
        return { status: 'paused', reason: 'awaiting_clips' }
      }
      // 'ready' (a future non-manual adapter, e.g. the API source): fall straight through to
      // collection below instead of pausing for a human who was never needed.
    }

    const stored = await ctx.clipRequests.listForRun(ctx.runId)
    const resolved = new Set(stored.filter((r) => r.fulfilledPath !== null || r.skipped).map((r) => r.sceneId))
    const pendingSpecs = specs.filter((s) => !resolved.has(s.sceneId))

    if (pendingSpecs.length > 0) {
      const results = await ctx.providers.clip.collect(pendingSpecs)
      const requestedAtMs = state ? new Date(state.requestedAt).getTime() : ctx.clock.now().getTime()
      const timedOut = ctx.clock.now().getTime() - requestedAtMs >= ctx.config.clips.waitTimeoutHours * 60 * 60 * 1000

      let stillPending = 0
      for (const result of results) {
        if (result.path !== null) {
          await ctx.clipRequests.markFulfilled(ctx.runId, result.sceneId, result.path)
        } else if (timedOut) {
          await ctx.clipRequests.markSkipped(ctx.runId, result.sceneId)
          ctx.log.warn(`clip for scene '${result.sceneId}' timed out; falling back to its image`, {
            stage: 'clip-gate',
          })
        } else {
          stillPending += 1
        }
      }

      if (stillPending > 0) {
        ctx.log.info(`clip gate still waiting on ${stillPending} shot(s)`, { stage: 'clip-gate' })
        return { status: 'paused', reason: 'awaiting_clips' }
      }
    }

    const final = await ctx.clipRequests.listForRun(ctx.runId)
    const fulfilled = final.filter((r) => r.fulfilledPath !== null).length
    const skipped = final.filter((r) => r.skipped).length
    ctx.log.info(`clip gate resolved: ${fulfilled} fulfilled, ${skipped} fell back to image`, {
      stage: 'clip-gate',
    })
    return { status: 'done' }
  },
})
