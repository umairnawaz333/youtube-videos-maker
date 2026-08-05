import fs from 'node:fs/promises'
import path from 'node:path'
import type { ImageProvider, ImageRequest } from '@yt/core'
import { createHttpImageGenClient, type ImageGenClient } from './client'

/**
 * `ImageProvider` adapter over the local imagegen sidecar. The sidecar returns raw PNG bytes;
 * writing them to `req.outPath` (creating parent directories as needed) is this provider's job,
 * not the sidecar's — the sidecar never touches the filesystem on the pipeline's behalf.
 */
export class HttpImageProvider implements ImageProvider {
  constructor(private readonly client: ImageGenClient) {}

  async generate(req: ImageRequest): Promise<{ outPath: string }> {
    const bytes = await this.client.generate({
      prompt: req.prompt,
      width: req.width,
      height: req.height,
      seed: req.seed,
    })
    await fs.mkdir(path.dirname(req.outPath), { recursive: true })
    await fs.writeFile(req.outPath, bytes)
    return { outPath: req.outPath }
  }

  /** Called by the ModelBroker only. */
  async unload(): Promise<void> {
    await this.client.unload()
  }
}

export const createHttpImageProvider = (opts: { host: string; fetchImpl?: typeof fetch }): ImageProvider =>
  new HttpImageProvider(createHttpImageGenClient(opts))
