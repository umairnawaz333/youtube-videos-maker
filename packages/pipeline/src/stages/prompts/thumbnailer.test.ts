import { describe, expect, it } from 'vitest'
import { buildHeroPrompt, HERO_STYLE_HINT } from './thumbnailer'

describe('buildHeroPrompt', () => {
  it('appends the hero style hint and the niche style suffix', () => {
    const prompt = buildHeroPrompt('a lone comet', 'cinematic astrophotography')
    expect(prompt).toContain('a lone comet')
    expect(prompt).toContain(HERO_STYLE_HINT)
    expect(prompt).toContain('cinematic astrophotography')
  })

  it('does not duplicate the style suffix if the scene prompt already carries it', () => {
    const prompt = buildHeroPrompt('a lone comet, cinematic astrophotography', 'cinematic astrophotography')
    const occurrences = prompt.toLowerCase().split('cinematic astrophotography').length - 1
    expect(occurrences).toBe(1)
  })
})
