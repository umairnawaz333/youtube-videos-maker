import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listNiches, loadConfig } from '@yt/pipeline'

const configDir = path.resolve(__dirname, '../../../../config')

describe('loadConfig', () => {
  it('loads app.json together with the niche named in it', async () => {
    const resolved = await loadConfig({ configDir })
    expect(resolved.nicheConfig.id).toBe(resolved.niche)
  })

  it('honours a per-run niche override', async () => {
    const resolved = await loadConfig({ configDir, request: { niche: 'politics' } })
    expect(resolved.nicheConfig.id).toBe('politics')
    expect(resolved.nicheConfig.monetizationRisk).toBe('high')
  })

  it('fails clearly when the niche file is missing', async () => {
    await expect(loadConfig({ configDir, request: { niche: 'crypto' } })).rejects.toThrow(
      /niche 'crypto' not found/,
    )
  })

  it('lists all eight shipped niches', async () => {
    const niches = await listNiches(configDir)
    expect(niches.map((n) => n.id).sort()).toEqual([
      'ai',
      'education',
      'knowledge',
      'politics',
      'programming',
      'science',
      'space',
      'tech',
    ])
  })
})
