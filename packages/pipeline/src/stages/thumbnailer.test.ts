import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ScenePlanSchema, type SceneVisual } from '@yt/core'
import type { FakeCallLog } from '@yt/providers'
import { createThumbnailerStage } from './thumbnailer'
import { HERO_STYLE_HINT } from './prompts/thumbnailer'
import { makeStageContext, type StageHarness } from '../../../../test/fixtures/stage-context'

/** See illustrator.test.ts for why this narrowing cast is needed. */
const fakeCalls = (h: StageHarness): FakeCallLog => (h.providers as unknown as { calls: FakeCallLog }).calls

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Minimal 8-bit RGB PNG encoder matching `decodePng`'s reader — see illustrator.test.ts for
 * the same helper. Duplicated rather than imported: it is test-only fixture code, not a shared
 * production concern of either stage. */
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
  ihdr[8] = 8
  ihdr[9] = 2
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))])
}

const sceneFor = (id: string, beatId: string, visual: SceneVisual) => ({
  id,
  beatId,
  text: `Narration for ${beatId}.`,
  visual,
  camera: 'zoom-in' as const,
})

describe('createThumbnailerStage', () => {
  let h: StageHarness
  beforeEach(async () => {
    h = await makeStageContext()
  })
  afterEach(async () => {
    await h.cleanup()
  })

  it('generates exactly five hero candidates named v1..v5.png', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: [
        sceneFor('scene-1', 'hook-0', { kind: 'sd-image', prompt: 'a lone comet' }),
        sceneFor('scene-2', 'reveal-0', { kind: 'sd-image', prompt: 'a black hole' }),
      ],
    })

    await expect(createThumbnailerStage().run(h.ctx)).resolves.toEqual({ status: 'done' })

    for (let i = 1; i <= 5; i++) {
      const stat = await fs.stat(path.join(h.ctx.paths.thumbnail, `v${i}.png`))
      expect(stat.isFile()).toBe(true)
    }
    expect(fakeCalls(h).images).toHaveLength(5)
  })

  it('does not touch the images/ directory — it only produces thumbnail candidates', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: [sceneFor('scene-1', 'hook-0', { kind: 'sd-image', prompt: 'a lone comet' })],
    })

    await createThumbnailerStage().run(h.ctx)

    const imagesDir = await fs.readdir(h.ctx.paths.images)
    expect(imagesDir).toHaveLength(0)
  })

  it('builds each candidate prompt from a scene prompt plus the hero hint and style suffix', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: [sceneFor('scene-1', 'hook-0', { kind: 'sd-image', prompt: 'a lone comet' })],
    })

    await createThumbnailerStage().run(h.ctx)

    for (const call of fakeCalls(h).images) {
      expect(call.prompt).toContain('a lone comet')
      expect(call.prompt).toContain(HERO_STYLE_HINT)
      expect(call.prompt).toContain(h.ctx.config.nicheConfig.styleSuffix)
    }
  })

  it('uses a distinct seed per candidate so five requests do not collapse into duplicates', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: [sceneFor('scene-1', 'hook-0', { kind: 'sd-image', prompt: 'a lone comet' })],
    })

    await createThumbnailerStage().run(h.ctx)

    const seeds = fakeCalls(h).images.map((c) => c.seed)
    expect(new Set(seeds).size).toBe(5)
  })

  it('cycles through available sd-image scenes when there are fewer than five', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: [
        sceneFor('scene-1', 'hook-0', { kind: 'sd-image', prompt: 'a lone comet' }),
        sceneFor('scene-2', 'reveal-0', { kind: 'sd-image', prompt: 'a black hole' }),
      ],
    })

    await createThumbnailerStage().run(h.ctx)

    const prompts = fakeCalls(h).images.map((c) => c.prompt)
    expect(prompts.filter((p) => p.includes('a lone comet'))).toHaveLength(3)
    expect(prompts.filter((p) => p.includes('a black hole'))).toHaveLength(2)
  })

  it('halts when the scene plan has no sd-image scenes to source hero candidates from', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: [sceneFor('scene-1', 'hook-0', { kind: 'motion-graphic', variant: 'stat', payload: {} })],
    })

    const outcome = await createThumbnailerStage().run(h.ctx)
    expect(outcome.status).toBe('halted')
    expect(fakeCalls(h).images).toHaveLength(0)
  })

  it('retries a black hero candidate rather than failing the whole stage', async () => {
    await h.ctx.artifacts.write('scenes', ScenePlanSchema, {
      scenes: [sceneFor('scene-1', 'hook-0', { kind: 'sd-image', prompt: 'a lone comet' })],
    })

    let calls = 0
    h.providers.image.generate = async (req) => {
      calls += 1
      await fs.mkdir(path.dirname(req.outPath), { recursive: true })
      // Every first attempt for a given candidate comes back black; each of the five
      // candidates therefore needs two provider calls, ten total.
      const bytes = calls % 2 === 1 ? encodeTestPng(2, 2, [0, 0, 0]) : encodeTestPng(2, 2, [180, 180, 180])
      await fs.writeFile(req.outPath, bytes)
      return { outPath: req.outPath }
    }

    await createThumbnailerStage().run(h.ctx)

    expect(calls).toBe(10)
  })
})
