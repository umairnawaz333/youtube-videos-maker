import { describe, expect, it } from 'vitest'
import {
  STAGE_NAMES,
  STAGE_REQUIREMENTS,
  STAGE_RETRY_KIND,
  SECTION_KINDS,
  RUN_STATUSES,
} from '@yt/core'

describe('stage vocabulary', () => {
  it('declares fourteen stages in the spec order', () => {
    expect(STAGE_NAMES).toEqual([
      'topic-scout',
      'researcher',
      'script-writer',
      'fact-checker',
      'scene-planner',
      'seo',
      'illustrator',
      'thumbnailer',
      'narrator',
      'captioner',
      'clip-gate',
      'editor',
      'quality-gate',
      'publisher',
    ])
  })

  it('forces the image model out before the small-model block begins', () => {
    // narrator is the first stage after the SD block. Marking it exclusive is what
    // evicts SDXL before narration, captioning and the Chromium render run.
    expect(STAGE_REQUIREMENTS.narrator).toBe('exclusive')
    expect(STAGE_REQUIREMENTS.editor).toBe('exclusive')
  })

  it('keeps the requirement sequence grouped so heavy models load at most once each', () => {
    const sequence = STAGE_NAMES.map((n) => STAGE_REQUIREMENTS[n])
    // Each heavy model appears in exactly one contiguous run.
    for (const heavy of ['llm', 'sd'] as const) {
      const indices = sequence.flatMap((req, i) => (req === heavy ? [i] : []))
      expect(indices.length).toBeGreaterThan(0)
      const contiguous = indices.every((idx, k) => k === 0 || idx === indices[k - 1]! + 1)
      expect(contiguous, `${heavy} requirements must be contiguous`).toBe(true)
    }
    // No heavy requirement may appear after the first exclusive stage.
    const firstExclusive = sequence.indexOf('exclusive')
    expect(firstExclusive).toBeGreaterThan(0)
    expect(sequence.slice(firstExclusive)).not.toContain('llm')
    expect(sequence.slice(firstExclusive)).not.toContain('sd')
  })

  it('gives every stage a retry kind', () => {
    for (const name of STAGE_NAMES) {
      expect(STAGE_RETRY_KIND[name]).toBeDefined()
    }
  })

  it('declares the eight story sections in arc order', () => {
    expect(SECTION_KINDS).toEqual([
      'hook',
      'question',
      'conflict',
      'curiosity',
      'reveal',
      'twist',
      'conclusion',
      'cta',
    ])
  })

  it('includes a paused status for the clip gate', () => {
    expect(RUN_STATUSES).toContain('awaiting_clips')
  })
})
