import fs from 'node:fs/promises'
import path from 'node:path'
import { NicheConfigSchema, type AppConfig, type NicheConfig, type ResolvedConfig } from '@yt/core'
import { resolveConfig } from './resolve'

const readJson = async (file: string): Promise<unknown> =>
  JSON.parse(await fs.readFile(file, 'utf8'))

export const listNiches = async (configDir: string): Promise<NicheConfig[]> => {
  const dir = path.join(configDir, 'niches')
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'))
  const niches: NicheConfig[] = []
  for (const file of files.sort()) {
    niches.push(NicheConfigSchema.parse(await readJson(path.join(dir, file))))
  }
  return niches
}

export const loadConfig = async (opts: {
  configDir: string
  request?: Partial<AppConfig>
}): Promise<ResolvedConfig> => {
  const app = (await readJson(path.join(opts.configDir, 'app.json'))) as Partial<AppConfig>
  const nicheId = opts.request?.niche ?? app.niche
  if (!nicheId) throw new Error('no niche specified in the request or app.json')

  const nicheFile = path.join(opts.configDir, 'niches', `${nicheId}.json`)
  let niche: unknown
  try {
    niche = await readJson(nicheFile)
  } catch {
    throw new Error(`niche '${nicheId}' not found at ${nicheFile}`)
  }

  return resolveConfig({ request: opts.request, app, niche })
}
