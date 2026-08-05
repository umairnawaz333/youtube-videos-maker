import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ScenePlanSchema, type ClipRequestSpec, type ClipResult, type RunContext, type Scene } from '@yt/core'
import { FixedClock } from '@yt/providers'
import { createClipGateStage } from './clip-gate'
import { sceneImagePath } from '../render/asset-paths'
import { makeStageContext, type StageHarness } from '../../../../test/fixtures/stage-context'

let h: StageHarness

const imageScene = (id: string): Scene => ({
  id,
  beatId: `${id}-beat`,
  text: `Narration for ${id}.`,
  visual: { kind: 'sd-image', prompt: `An image for ${id}` },
  camera: 'zoom-in',
  durationSec: 6,
})

const clipScene = (id: string, referenceSceneId: string, durationSec = 6): Scene => ({
  id,
  beatId: `${id}-beat`,
  text: `Narration for ${id}.`,
  visual: {
    kind: 'veo-clip',
    prompt: `A clip for ${id}`,
    referenceSceneId,
    fallbackPrompt: `Fallback image for ${id}`,
  },
  camera: 'zoom-in',
  durationSec,
})

beforeEach(async () => {
  h = await makeStageContext({ videoType: 'long' }) // long preset: 16:9, clip budget 6
})
afterEach(async () => {
  await h.cleanup()
})

describe('createClipGateStage', () => {
  it('does nothing when clips are disabled', async () => {
    // Never mutate `h.ctx.config.clips` in place: `makeStageContext` shallow-copies
    // `DEFAULT_APP_CONFIG`, so its nested `clips` object is shared across every stage
    // context in the process, and mutating it here would leak into every other test.
    h.ctx.config = { ...h.ctx.config, clips: { ...h.ctx.config.clips, enabled: false } }
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: [clipScene('scene-hook-0', 'scene-ref-0')],
    })

    let called = false
    h.providers.clip.request = async () => {
      called = true
      return { status: 'paused' }
    }

    const outcome = await createClipGateStage().run(h.ctx)
    expect(outcome).toEqual({ status: 'done' })
    expect(called).toBe(false)
  })

  it('does nothing when the plan has no veo-clip scenes', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, { scenes: [imageScene('scene-hook-0')] })

    const outcome = await createClipGateStage().run(h.ctx)
    expect(outcome).toEqual({ status: 'done' })
  })

  it('requests exactly one shot per veo-clip scene, using the measured duration', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: [imageScene('scene-ref-0'), clipScene('scene-hook-0', 'scene-ref-0', 7)],
    })

    const requested: ClipRequestSpec[][] = []
    h.providers.clip.request = async (specs) => {
      requested.push(specs)
      return { status: 'paused' }
    }

    const outcome = await createClipGateStage().run(h.ctx)

    expect(outcome).toEqual({ status: 'paused', reason: 'awaiting_clips' })
    expect(requested).toHaveLength(1)
    expect(requested[0]).toEqual([
      {
        sceneId: 'scene-hook-0',
        prompt: 'A clip for scene-hook-0',
        referenceImagePath: sceneImagePath(h.ctx.paths, 'scene-ref-0'),
        targetSeconds: 7,
        aspectRatio: '16:9',
      },
    ])

    const stored = await h.ctx.clipRequests.listForRun(h.ctx.runId)
    expect(stored).toEqual([
      {
        sceneId: 'scene-hook-0',
        prompt: 'A clip for scene-hook-0',
        referenceImagePath: sceneImagePath(h.ctx.paths, 'scene-ref-0'),
        targetSeconds: 7,
        fulfilledPath: null,
        skipped: false,
      },
    ])
  })

  it('uses 9:16 for the shorts preset', async () => {
    const shorts = await makeStageContext({ videoType: 'shorts', runId: 'run-shorts' })
    await shorts.ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: [imageScene('scene-ref-0'), clipScene('scene-hook-0', 'scene-ref-0')],
    })
    const requested: ClipRequestSpec[][] = []
    shorts.providers.clip.request = async (specs) => {
      requested.push(specs)
      return { status: 'paused' }
    }

    await createClipGateStage().run(shorts.ctx)
    expect(requested[0]![0]!.aspectRatio).toBe('9:16')
    await shorts.cleanup()
  })

  it('halts when a veo-clip scene has no measured duration yet', async () => {
    const scenes: Scene[] = [
      imageScene('scene-ref-0'),
      { ...clipScene('scene-hook-0', 'scene-ref-0'), durationSec: undefined },
    ]
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, { scenes })

    const outcome = await createClipGateStage().run(h.ctx)
    expect(outcome).toMatchObject({ status: 'halted' })
    expect((outcome as { reason: string }).reason).toMatch(/duration/i)
  })

  it('finalises a fulfilled clip as fulfilled on resume', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: [imageScene('scene-ref-0'), clipScene('scene-hook-0', 'scene-ref-0')],
    })

    // First pass: writes the request and pauses.
    await createClipGateStage().run(h.ctx)

    // Human drops a clip in; collect() now resolves it.
    h.providers.clip.collect = async (specs: ClipRequestSpec[]): Promise<ClipResult[]> =>
      specs.map((s) => ({ sceneId: s.sceneId, path: '/tmp/normalised/scene-hook-0.mp4' }))

    const outcome = await createClipGateStage().run(h.ctx)
    expect(outcome).toEqual({ status: 'done' })

    const stored = await h.ctx.clipRequests.listForRun(h.ctx.runId)
    expect(stored[0]).toMatchObject({ fulfilledPath: '/tmp/normalised/scene-hook-0.mp4', skipped: false })
  })

  it('keeps waiting (pauses again) while a shot is unresolved and inside the timeout window', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: [imageScene('scene-ref-0'), clipScene('scene-hook-0', 'scene-ref-0')],
    })

    await createClipGateStage().run(h.ctx) // first pass: pauses

    // Nobody has dropped anything yet, and we are still well inside waitTimeoutHours (72h).
    h.providers.clip.collect = async (specs: ClipRequestSpec[]): Promise<ClipResult[]> =>
      specs.map((s) => ({ sceneId: s.sceneId, path: null }))

    const outcome = await createClipGateStage().run(h.ctx)
    expect(outcome).toEqual({ status: 'paused', reason: 'awaiting_clips' })

    const stored = await h.ctx.clipRequests.listForRun(h.ctx.runId)
    expect(stored[0]).toMatchObject({ fulfilledPath: null, skipped: false })
  })

  it('auto-falls-back to the image once waitTimeoutHours has elapsed', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: [imageScene('scene-ref-0'), clipScene('scene-hook-0', 'scene-ref-0')],
    })

    await createClipGateStage().run(h.ctx) // first pass: pauses, records requestedAt

    h.providers.clip.collect = async (specs: ClipRequestSpec[]): Promise<ClipResult[]> =>
      specs.map((s) => ({ sceneId: s.sceneId, path: null }))

    // Fast-forward the fixed clock past the default 72-hour timeout.
    ;(h.ctx.clock as FixedClock).advance(73 * 60 * 60 * 1000)

    const outcome = await createClipGateStage().run(h.ctx)
    expect(outcome).toEqual({ status: 'done' })

    const stored = await h.ctx.clipRequests.listForRun(h.ctx.runId)
    expect(stored[0]).toMatchObject({ fulfilledPath: null, skipped: true })
  })

  it('resolves multiple shots independently: one fulfilled, one still pending', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: [
        imageScene('scene-ref-0'),
        imageScene('scene-ref-1'),
        clipScene('scene-hook-0', 'scene-ref-0'),
        clipScene('scene-reveal-0', 'scene-ref-1'),
      ],
    })

    await createClipGateStage().run(h.ctx)

    h.providers.clip.collect = async (specs: ClipRequestSpec[]): Promise<ClipResult[]> =>
      specs.map((s) => ({
        sceneId: s.sceneId,
        path: s.sceneId === 'scene-hook-0' ? '/tmp/normalised/scene-hook-0.mp4' : null,
      }))

    const outcome = await createClipGateStage().run(h.ctx)
    expect(outcome).toEqual({ status: 'paused', reason: 'awaiting_clips' })

    const stored = await h.ctx.clipRequests.listForRun(h.ctx.runId)
    const hook = stored.find((s) => s.sceneId === 'scene-hook-0')!
    const reveal = stored.find((s) => s.sceneId === 'scene-reveal-0')!
    expect(hook).toMatchObject({ fulfilledPath: '/tmp/normalised/scene-hook-0.mp4' })
    expect(reveal).toMatchObject({ fulfilledPath: null, skipped: false })
  })
})
