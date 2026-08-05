import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageGenClient } from './client'
import { HttpImageProvider } from './image-provider'

describe('HttpImageProvider', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-image-provider-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('writes the bytes returned by the client to outPath, creating directories as needed', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const client: ImageGenClient = {
      generate: vi.fn(async () => pngBytes),
      unload: vi.fn(async () => {}),
    }
    const provider = new HttpImageProvider(client)
    const outPath = path.join(dir, 'nested', 'scene-1.png')

    const result = await provider.generate({ prompt: 'a nebula', width: 1024, height: 1024, seed: 42, outPath })

    expect(result).toEqual({ outPath })
    expect(await fs.readFile(outPath)).toEqual(pngBytes)
    expect(client.generate).toHaveBeenCalledWith({ prompt: 'a nebula', width: 1024, height: 1024, seed: 42 })
  })

  it('delegates unload() to the underlying client', async () => {
    const client: ImageGenClient = {
      generate: vi.fn(async () => Buffer.from([])),
      unload: vi.fn(async () => {}),
    }
    const provider = new HttpImageProvider(client)

    await provider.unload()

    expect(client.unload).toHaveBeenCalledOnce()
  })
})
