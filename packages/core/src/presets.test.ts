import { describe, expect, it } from 'vitest'
import { FORMAT_PRESETS } from '@yt/core'

describe('format presets', () => {
  it('defines vertical shorts', () => {
    expect(FORMAT_PRESETS.shorts).toMatchObject({
      width: 1080,
      height: 1920,
      fps: 30,
      minDurationSec: 45,
      maxDurationSec: 60,
      minScenes: 8,
      maxScenes: 12,
      imageBudget: 10,
      clipBudget: 2,
    })
  })

  it('defines horizontal long-form', () => {
    expect(FORMAT_PRESETS.long).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 30,
      minDurationSec: 480,
      maxDurationSec: 600,
      minScenes: 60,
      maxScenes: 90,
      imageBudget: 70,
      clipBudget: 6,
    })
  })

  it('keeps the image budget consistent with one image per 8-10 seconds', () => {
    for (const preset of Object.values(FORMAT_PRESETS)) {
      const perImageSeconds = preset.maxDurationSec / preset.imageBudget
      expect(perImageSeconds).toBeGreaterThanOrEqual(6)
      expect(perImageSeconds).toBeLessThanOrEqual(10)
    }
  })
})
