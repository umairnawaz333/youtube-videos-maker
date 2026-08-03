import fs from 'node:fs/promises'
import path from 'node:path'
import type { z } from 'zod'
import type { ArtifactName, ArtifactStore, RunPaths } from '@yt/core'

/**
 * Artifacts are validated on the way in and on the way out. A stage can therefore trust
 * that any artifact it reads matches its schema, which is what makes resuming safe.
 */
export class FileArtifactStore implements ArtifactStore {
  constructor(private readonly paths: RunPaths) {}

  private file(name: ArtifactName): string {
    return path.join(this.paths.root, `${name}.json`)
  }

  async write<T>(name: ArtifactName, schema: z.ZodType<T>, data: T): Promise<void> {
    const parsed = schema.safeParse(data)
    if (!parsed.success) {
      throw new Error(
        `artifact '${name}' failed validation on write: ${JSON.stringify(parsed.error.issues)}`,
      )
    }
    await fs.mkdir(this.paths.root, { recursive: true })
    await fs.writeFile(this.file(name), `${JSON.stringify(parsed.data, null, 2)}\n`, 'utf8')
  }

  async read<T>(name: ArtifactName, schema: z.ZodType<T>): Promise<T> {
    let raw: string
    try {
      raw = await fs.readFile(this.file(name), 'utf8')
    } catch {
      throw new Error(`artifact '${name}' not found at ${this.file(name)}`)
    }

    const parsed = schema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      throw new Error(
        `artifact '${name}' failed validation on read: ${JSON.stringify(parsed.error.issues)}`,
      )
    }
    return parsed.data
  }

  async exists(name: ArtifactName): Promise<boolean> {
    try {
      await fs.access(this.file(name))
      return true
    } catch {
      return false
    }
  }
}
