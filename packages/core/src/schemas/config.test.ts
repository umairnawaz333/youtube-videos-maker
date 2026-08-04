import { describe, expect, it } from 'vitest'
import { AppConfigSchema, NicheConfigSchema, DEFAULT_APP_CONFIG } from '@yt/core'

describe('AppConfigSchema', () => {
  it('accepts the default config', () => {
    expect(AppConfigSchema.safeParse(DEFAULT_APP_CONFIG).success).toBe(true)
  })

  it('defaults autoPublish to false so nothing publishes unreviewed', () => {
    expect(DEFAULT_APP_CONFIG.autoPublish).toBe(false)
  })

  it('defaults the clip gate to manual with a 72 hour timeout', () => {
    expect(DEFAULT_APP_CONFIG.clips).toMatchObject({
      enabled: true,
      source: 'manual',
      maxSeconds: 8,
      stripAudio: true,
      fallback: 'image',
      waitTimeoutHours: 72,
    })
  })

  it('rejects an unknown video type', () => {
    const bad = { ...DEFAULT_APP_CONFIG, videoType: 'square' }
    expect(AppConfigSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a clip placement that is not a story section', () => {
    const bad = {
      ...DEFAULT_APP_CONFIG,
      clips: { ...DEFAULT_APP_CONFIG.clips, placement: ['outro'] },
    }
    expect(AppConfigSchema.safeParse(bad).success).toBe(false)
  })
})

describe('NicheConfigSchema', () => {
  const niche = {
    id: 'space',
    label: 'Space',
    promptGuidance: 'Explain one cosmic phenomenon through a single concrete object.',
    voice: 'male',
    styleSuffix: 'cinematic astrophotography, deep blacks, volumetric light',
    music: 'ambient-drone',
    trendSources: ['wikipedia-top', 'arxiv'],
    seoRules: 'Lead with the object, not the concept.',
    monetizationRisk: 'low',
  }

  it('accepts a well-formed niche', () => {
    expect(NicheConfigSchema.safeParse(niche).success).toBe(true)
  })

  it('rejects an unknown trend source', () => {
    expect(NicheConfigSchema.safeParse({ ...niche, trendSources: ['tiktok'] }).success).toBe(false)
  })

  it('requires a monetization risk rating', () => {
    const { monetizationRisk, ...withoutRisk } = niche
    expect(NicheConfigSchema.safeParse(withoutRisk).success).toBe(false)
  })
})
