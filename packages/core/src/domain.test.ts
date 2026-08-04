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

  it('groups model requirements so there are exactly two model swaps', () => {
    const sequence = STAGE_NAMES.map((n) => STAGE_REQUIREMENTS[n])
    const compacted = sequence.filter((req, i) => req !== sequence[i - 1])
    expect(compacted).toEqual(['llm', 'sd', 'none'])
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
