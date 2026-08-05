import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  STAGE_REQUIREMENTS,
  ScenePlanSchema,
  type ImageRequest,
  type RunContext,
  type Scene,
  type SceneVisual,
  type Stage,
} from '@yt/core'
import { deriveBaseSeed, ensureStyleSuffix, SDXL_IMAGE_SIZE } from './prompts/illustrator'

/**
 * How many times a single image is retried before the whole stage gives up on it. Kept separate
 * from the stage-level attempt budget (`STAGE_RETRY_KIND.illustrator === 'local'`, 1 attempt by
 * default in `DEFAULT_APP_CONFIG`): re-running the *entire* stage on one bad image would
 * regenerate every already-good image in the plan, which is exactly the per-call cost this
 * stage exists to keep low.
 */
const MAX_IMAGE_ATTEMPTS = 3

/**
 * A pixel's colour channels (excluding alpha) must all sit at or below this to count as "black"
 * for retry purposes. Deliberately close to 0 rather than merely "dark": several niches' own
 * style suffixes ask for deep blacks (e.g. space's "cinematic astrophotography, deep blacks"),
 * so a generic "mostly dark" threshold would misfire on a correctly generated image. What this
 * catches is the SDXL failure mode of a uniformly solid black frame (design spec, section 4,
 * stage 7: "Black or failed outputs are retried automatically").
 */
const BLACK_CHANNEL_MAX = 2

interface DecodedPng {
  width: number
  height: number
  /** 1 = grayscale, 2 = grayscale+alpha, 3 = RGB, 4 = RGBA. */
  channels: number
  pixels: Buffer
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CHANNELS_BY_COLOR_TYPE: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 }

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/**
 * Minimal PNG decoder covering exactly what this stage needs: non-interlaced, 8-bit
 * grayscale/RGB(+alpha) images — what both the SDXL sidecar and every test fixture in this repo
 * produce. No external dependency is pulled in for this; Node's built-in zlib is the only
 * requirement, kept so the hermetic unit suite never needs a real image-processing library.
 */
export const decodePng = (buf: Buffer): DecodedPng => {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG file (bad signature)')
  }

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat: Buffer[] = []

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length // 4-byte length + 4-byte type + data + 4-byte crc

    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data.readUInt8(8)
      colorType = data.readUInt8(9)
      interlace = data.readUInt8(12)
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
  }

  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`)
  if (interlace !== 0) throw new Error('interlaced PNG is not supported')
  const channels = CHANNELS_BY_COLOR_TYPE[colorType]
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`)

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  let prevLine = Buffer.alloc(stride)
  let pos = 0

  for (let y = 0; y < height; y++) {
    const filterType = raw[pos]
    pos += 1
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const outLine = Buffer.alloc(stride)

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? outLine[x - channels]! : 0
      const b = prevLine[x]!
      const c = x >= channels ? prevLine[x - channels]! : 0
      const raw8 = line[x]!
      let value: number
      switch (filterType) {
        case 0:
          value = raw8
          break
        case 1:
          value = (raw8 + a) & 0xff
          break
        case 2:
          value = (raw8 + b) & 0xff
          break
        case 3:
          value = (raw8 + Math.floor((a + b) / 2)) & 0xff
          break
        case 4:
          value = (raw8 + paeth(a, b, c)) & 0xff
          break
        default:
          throw new Error(`unsupported PNG filter type ${filterType}`)
      }
      outLine[x] = value
    }

    outLine.copy(pixels, y * stride)
    prevLine = outLine
  }

  return { width, height, channels, pixels }
}

/**
 * True when every colour channel of every pixel is at or below `BLACK_CHANNEL_MAX` — a solid
 * black frame, the known SDXL failure mode this stage retries. Alpha is ignored: a fully-opaque
 * black image and a black-with-alpha image are the same failure for this purpose.
 */
export const isLikelyBlackPng = (buf: Buffer): boolean => {
  const { channels, pixels } = decodePng(buf)
  const hasAlpha = channels === 2 || channels === 4
  const colorChannels = hasAlpha ? channels - 1 : channels

  for (let i = 0; i + channels <= pixels.length; i += channels) {
    for (let c = 0; c < colorChannels; c++) {
      if (pixels[i + c]! > BLACK_CHANNEL_MAX) return false
    }
  }
  return true
}

/**
 * Generates one image, retrying on a thrown error or a detected black frame. Perturbs the seed
 * on each retry (base seed + attempt index) so a deterministically-black seed does not just
 * reproduce the same failure forever. Shared by the illustrator and thumbnailer stages, since
 * both hit the exact same failure mode against the exact same provider.
 */
export const generateImageWithRetry = async (
  ctx: Pick<RunContext, 'providers' | 'log'>,
  req: ImageRequest,
): Promise<{ outPath: string; attempts: number }> => {
  let lastError = 'unknown error'

  for (let attempt = 1; attempt <= MAX_IMAGE_ATTEMPTS; attempt++) {
    const attemptReq: ImageRequest = { ...req, seed: req.seed + (attempt - 1) }
    try {
      await ctx.providers.image.generate(attemptReq)
      const bytes = await fs.readFile(attemptReq.outPath)
      if (!isLikelyBlackPng(bytes)) {
        return { outPath: attemptReq.outPath, attempts: attempt }
      }
      lastError = 'generated image was entirely black'
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }

    if (attempt < MAX_IMAGE_ATTEMPTS) {
      ctx.log.warn(
        `retrying image at ${req.outPath} (attempt ${attempt}/${MAX_IMAGE_ATTEMPTS} failed: ${lastError})`,
      )
    }
  }

  throw new Error(
    `failed to generate a usable image at ${req.outPath} after ${MAX_IMAGE_ATTEMPTS} attempts (last error: ${lastError})`,
  )
}

/** Narrows a scene to one whose visual is the sd-image variant. Exported so the thumbnailer
 * stage (which also needs to find sd-image scenes to source hero candidates from) shares it. */
export const isSdImageScene = (
  scene: Scene,
): scene is Scene & { visual: Extract<SceneVisual, { kind: 'sd-image' }> } => scene.visual.kind === 'sd-image'

export const createIllustratorStage = (): Stage => ({
  name: 'illustrator',
  requires: STAGE_REQUIREMENTS.illustrator,

  async run(ctx) {
    const plan = await ctx.artifacts.read('scenes', ScenePlanSchema)
    const baseSeed = deriveBaseSeed(ctx.runId)
    const budget = ctx.config.preset.imageBudget
    const imageScenes = plan.scenes.filter(isSdImageScene)

    // The scene-planner already enforces this budget when it writes scenes.json, so this
    // branch should not normally trigger. It stays as a defensive check rather than a silent
    // no-op: a scene plan that got here some other way (a hand edit, a forced re-run of just
    // this stage) still deserves every image it references — dropping images arbitrarily would
    // leave scenes.json pointing at files that never got created, corrupting a later stage
    // instead of this one.
    if (imageScenes.length > budget) {
      ctx.log.warn(
        `scene plan has ${imageScenes.length} sd-image scenes but the ${ctx.config.preset.format} ` +
          `preset budgets ${budget}; generating all of them rather than dropping referenced images`,
      )
    }

    let retried = 0
    for (const scene of imageScenes) {
      const prompt = ensureStyleSuffix(scene.visual.prompt, ctx.config.nicheConfig.styleSuffix)
      const outPath = path.join(ctx.paths.images, `${scene.id}.png`)
      const result = await generateImageWithRetry(ctx, {
        prompt,
        width: SDXL_IMAGE_SIZE,
        height: SDXL_IMAGE_SIZE,
        seed: baseSeed,
        outPath,
      })
      if (result.attempts > 1) retried += 1
    }

    ctx.log.info(
      `illustrated ${imageScenes.length} scene(s)${retried > 0 ? ` (${retried} needed a retry)` : ''}`,
    )
    return { status: 'done' }
  },
})
