import { describe, expect, it } from 'vitest'
import { deriveBaseSeed, ensureStyleSuffix, SDXL_IMAGE_SIZE } from './illustrator'

describe('ensureStyleSuffix', () => {
  it('appends the style suffix when it is absent', () => {
    expect(ensureStyleSuffix('a lone comet', 'cinematic astrophotography')).toBe(
      'a lone comet, cinematic astrophotography',
    )
  })

  it('does not duplicate the suffix when the prompt already ends with it', () => {
    const prompt = 'a lone comet, cinematic astrophotography'
    expect(ensureStyleSuffix(prompt, 'cinematic astrophotography')).toBe(prompt)
  })

  it('matches case-insensitively so an LLM-cased variant is not duplicated', () => {
    const prompt = 'a lone comet, Cinematic Astrophotography'
    expect(ensureStyleSuffix(prompt, 'cinematic astrophotography')).toBe(prompt)
  })

  it('is a no-op for a blank style suffix', () => {
    expect(ensureStyleSuffix('a lone comet', '   ')).toBe('a lone comet')
  })
})

describe('deriveBaseSeed', () => {
  it('is deterministic for the same run id', () => {
    expect(deriveBaseSeed('run-abc')).toBe(deriveBaseSeed('run-abc'))
  })

  it('differs across run ids', () => {
    expect(deriveBaseSeed('run-abc')).not.toBe(deriveBaseSeed('run-xyz'))
  })

  it('is always a non-negative integer', () => {
    const seed = deriveBaseSeed('run-abc')
    expect(Number.isInteger(seed)).toBe(true)
    expect(seed).toBeGreaterThanOrEqual(0)
  })
})

describe('SDXL_IMAGE_SIZE', () => {
  it('is the sidecar\'s native square resolution', () => {
    expect(SDXL_IMAGE_SIZE).toBe(1024)
  })
})
