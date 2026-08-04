import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AppConfigSchema, NicheConfigSchema } from '@yt/core'

const configDir = path.resolve(__dirname, '../../../../config')
const nicheDir = path.join(configDir, 'niches')

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'))

describe('shipped config files', () => {
  it('app.json satisfies the schema', () => {
    const parsed = AppConfigSchema.safeParse(readJson(path.join(configDir, 'app.json')))
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
  })

  it('ships the eight niches named in the spec', () => {
    const files = fs.readdirSync(nicheDir).filter((f) => f.endsWith('.json')).sort()
    expect(files).toEqual([
      'ai.json',
      'education.json',
      'knowledge.json',
      'politics.json',
      'programming.json',
      'science.json',
      'space.json',
      'tech.json',
    ])
  })

  it('every niche file satisfies the schema and matches its filename', () => {
    for (const file of fs.readdirSync(nicheDir).filter((f) => f.endsWith('.json'))) {
      const parsed = NicheConfigSchema.safeParse(readJson(path.join(nicheDir, file)))
      expect(parsed.success, `${file}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true)
      expect(parsed.success && parsed.data.id).toBe(path.basename(file, '.json'))
    }
  })

  it('flags politics as high monetization risk with explainer-only framing', () => {
    const politics = NicheConfigSchema.parse(readJson(path.join(nicheDir, 'politics.json')))
    expect(politics.monetizationRisk).toBe('high')
    expect(politics.promptGuidance.toLowerCase()).toContain('explainer')
  })
})
