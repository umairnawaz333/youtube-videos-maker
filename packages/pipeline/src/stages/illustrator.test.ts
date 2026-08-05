import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ScenePlanSchema, SECTION_KINDS, type ImageRequest, type RunContext, type SceneVisual } from '@yt/core'
import type { FakeCallLog } from '@yt/providers'
import { createIllustratorStage, decodePng, generateImageWithRetry, isLikelyBlackPng } from './illustrator'
import { makeStageContext, type StageHarness } from '../../../../test/fixtures/stage-context'

/** `StageHarness.providers` is typed as the plain `ProviderBundle` interface, but
 * `makeStageContext` always constructs it via `createFakeProviders()`, which additionally
 * attaches a `calls` log. Narrowing that back here keeps the harness's own public type honest
 * (a real provider bundle has no `calls`) while still letting these tests inspect it. */
const fakeCalls = (h: StageHarness): FakeCallLog => (h.providers as unknown as { calls: FakeCallLog }).calls

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Minimal 8-bit RGB PNG encoder, matched to `decodePng`'s reader. Filter type 0 (none) on
 * every scanline; the decoder does not verify chunk CRCs, so encoding real ones is unnecessary. */
const encodeTestPng = (width: number, height: number, rgb: [number, number, number]): Buffer => {
  const stride = width * 3
  const raw = Buffer.alloc(height * (1 + stride))
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + stride)
    raw[rowStart] = 0
    for (let x = 0; x < width; x++) {
      raw[rowStart + 1 + x * 3] = rgb[0]
      raw[rowStart + 1 + x * 3 + 1] = rgb[1]
      raw[rowStart + 1 + x * 3 + 2] = rgb[2]
    }
  }
  const compressed = zlib.deflateSync(raw)

  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: RGB
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0 // interlace: none

  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))])
}

describe('decodePng / isLikelyBlackPng', () => {
  it('decodes a solid-colour RGB PNG back to its exact pixel values', () => {
    const png = encodeTestPng(2, 2, [12, 34, 56])
    const decoded = decodePng(png)
    expect(decoded.width).toBe(2)
    expect(decoded.height).toBe(2)
    expect(decoded.channels).toBe(3)
    expect([...decoded.pixels.subarray(0, 3)]).toEqual([12, 34, 56])
  })

  it('flags a solid black image as likely black', () => {
    expect(isLikelyBlackPng(encodeTestPng(4, 4, [0, 0, 0]))).toBe(true)
  })

  it('does not flag a normally dark-but-not-black image', () => {
    expect(isLikelyBlackPng(encodeTestPng(4, 4, [10, 10, 10]))).toBe(false)
  })

  it('does not flag a bright image', () => {
    expect(isLikelyBlackPng(encodeTestPng(4, 4, [200, 40, 40]))).toBe(false)
  })

  it('rejects bytes that are not a PNG at all', () => {
    expect(() => decodePng(Buffer.from('not a png'))).toThrow(/signature/)
  })
})

describe('generateImageWithRetry', () => {
  let h: StageHarness
  beforeEach(async () => {
    h = await makeStageContext()
  })
  afterEach(async () => {
    await h.cleanup()
  })

  it('perturbs the seed and succeeds once a non-black image is produced', async () => {
    const seenSeeds: number[] = []
    let attempt = 0
    h.providers.image.generate = async (req: ImageRequest) => {
      seenSeeds.push(req.seed)
      attempt += 1
      await fs.mkdir(path.dirname(req.outPath), { recursive: true })
      await fs.writeFile(req.outPath, encodeTestPng(2, 2, attempt === 1 ? [0, 0, 0] : [180, 180, 180]))
      return { outPath: req.outPath }
    }

    const outPath = path.join(h.ctx.paths.images, 'scene-1.png')
    const result = await generateImageWithRetry(h.ctx, {
      prompt: 'a nebula',
      width: 1024,
      height: 1024,
      seed: 42,
      outPath,
    })

    expect(result.attempts).toBe(2)
    expect(seenSeeds).toEqual([42, 43])
    expect(isLikelyBlackPng(await fs.readFile(outPath))).toBe(false)
  })

  it('throws a descriptive error after exhausting attempts on a provider that always fails', async () => {
    h.providers.image.generate = async () => {
      throw new Error('sidecar unreachable')
    }

    await expect(
      generateImageWithRetry(h.ctx, {
        prompt: 'a nebula',
        width: 1024,
        height: 1024,
        seed: 1,
        outPath: path.join(h.ctx.paths.images, 'scene-1.png'),
      }),
    ).rejects.toThrow(/failed to generate a usable image.*sidecar unreachable/s)
  })
})

const sceneFor = (id: string, beatId: string, visual: SceneVisual) => ({
  id,
  beatId,
  text: `Narration for ${beatId}.`,
  visual,
  camera: 'zoom-in' as const,
})

describe('createIllustratorStage', () => {
  let h: StageHarness
  beforeEach(async () => {
    h = await makeStageContext()
  })
  afterEach(async () => {
    await h.cleanup()
  })

  it('generates one image per sd-image scene and skips reuse/motion-graphic scenes', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: [
        sceneFor('scene-1', 'hook-0', { kind: 'sd-image', prompt: 'a lone comet' }),
        sceneFor('scene-2', 'question-0', { kind: 'reuse', sceneId: 'scene-1' }),
        sceneFor('scene-3', 'conflict-0', {
          kind: 'motion-graphic',
          variant: 'stat',
          payload: {},
        }),
      ],
    })

    await expect(createIllustratorStage().run(h.ctx)).resolves.toEqual({ status: 'done' })

    expect(fakeCalls(h).images).toHaveLength(1)
    expect(fakeCalls(h).images[0]!.outPath).toBe(path.join(h.ctx.paths.images, 'scene-1.png'))
    await expect(fs.access(path.join(h.ctx.paths.images, 'scene-2.png'))).rejects.toThrow()
  })

  it('applies the niche style suffix and a shared per-run base seed to every image', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: [
        sceneFor('scene-1', 'hook-0', { kind: 'sd-image', prompt: 'a lone comet' }),
        sceneFor('scene-2', 'question-0', { kind: 'sd-image', prompt: 'a distant galaxy' }),
      ],
    })

    await createIllustratorStage().run(h.ctx)

    const [first, second] = fakeCalls(h).images
    expect(first!.prompt).toContain('a lone comet')
    expect(first!.prompt).toContain(h.ctx.config.nicheConfig.styleSuffix)
    expect(second!.seed).toBe(first!.seed)
  })

  it('does not duplicate a style suffix the scene-planner already included', async () => {
    const styleSuffix = h.ctx.config.nicheConfig.styleSuffix
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: [sceneFor('scene-1', 'hook-0', { kind: 'sd-image', prompt: `a lone comet, ${styleSuffix}` })],
    })

    await createIllustratorStage().run(h.ctx)

    const occurrences = fakeCalls(h).images[0]!.prompt.toLowerCase().split(styleSuffix.toLowerCase()).length - 1
    expect(occurrences).toBe(1)
  })

  it('retries a black output and keeps the good one', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: [sceneFor('scene-1', 'hook-0', { kind: 'sd-image', prompt: 'a lone comet' })],
    })

    let calls = 0
    h.providers.image.generate = async (req: ImageRequest) => {
      calls += 1
      await fs.mkdir(path.dirname(req.outPath), { recursive: true })
      await fs.writeFile(req.outPath, encodeTestPng(2, 2, calls === 1 ? [0, 0, 0] : [180, 180, 180]))
      return { outPath: req.outPath }
    }

    await createIllustratorStage().run(h.ctx)

    expect(calls).toBe(2)
    const bytes = await fs.readFile(path.join(h.ctx.paths.images, 'scene-1.png'))
    expect(isLikelyBlackPng(bytes)).toBe(false)
    expect(h.logs.some((l) => l.level === 'warn' && l.message.includes('retrying'))).toBe(true)
  })

  it('warns but still generates every sd-image scene when the plan exceeds the preset budget', async () => {
    const shorts = await makeStageContext({ videoType: 'shorts', runId: 'run-over-budget' })
    // The shorts preset budgets 22 images; force a plan with more sd-image scenes than that by
    // overriding the resolved preset's budget down to something trivially small instead.
    const ctx: RunContext = { ...shorts.ctx, config: { ...shorts.ctx.config, preset: { ...shorts.ctx.config.preset, imageBudget: 1 } } }
    await ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: [
        sceneFor('scene-1', 'hook-0', { kind: 'sd-image', prompt: 'a lone comet' }),
        sceneFor('scene-2', 'question-0', { kind: 'sd-image', prompt: 'a distant galaxy' }),
      ],
    })

    await createIllustratorStage().run(ctx)

    expect(fakeCalls(shorts).images).toHaveLength(2)
    expect(shorts.logs.some((l) => l.level === 'warn' && l.message.includes('budget'))).toBe(true)
    await shorts.cleanup()
  })

  it('propagates a permanently failing generation as a rejection', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: [sceneFor('scene-1', 'hook-0', { kind: 'sd-image', prompt: 'a lone comet' })],
    })
    h.providers.image.generate = async () => {
      throw new Error('sidecar unreachable')
    }

    await expect(createIllustratorStage().run(h.ctx)).rejects.toThrow(/sidecar unreachable/)
  })

  it('produces exactly one scene per section when driven by a full scene plan (sanity check)', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: SECTION_KINDS.map((k, i) => sceneFor(`scene-${i}`, `${k}-0`, { kind: 'sd-image', prompt: `image for ${k}` })),
    })

    await createIllustratorStage().run(h.ctx)

    expect(fakeCalls(h).images).toHaveLength(SECTION_KINDS.length)
  })
})
