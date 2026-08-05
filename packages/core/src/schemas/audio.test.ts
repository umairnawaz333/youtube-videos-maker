import { describe, expect, it } from 'vitest'
import { CaptionWordSchema, CaptionWordsFileSchema } from './audio'

describe('CaptionWordSchema', () => {
  it('accepts a well-formed word', () => {
    expect(CaptionWordSchema.parse({ word: 'hello', startSec: 0, endSec: 0.4 })).toEqual({
      word: 'hello',
      startSec: 0,
      endSec: 0.4,
    })
  })

  it('rejects an empty word', () => {
    expect(() => CaptionWordSchema.parse({ word: '', startSec: 0, endSec: 0.4 })).toThrow()
  })

  it('rejects endSec before startSec', () => {
    expect(() => CaptionWordSchema.parse({ word: 'hi', startSec: 1, endSec: 0.5 })).toThrow()
  })

  it('rejects a negative startSec', () => {
    expect(() => CaptionWordSchema.parse({ word: 'hi', startSec: -1, endSec: 0.5 })).toThrow()
  })
})

describe('CaptionWordsFileSchema', () => {
  it('accepts an empty word list', () => {
    expect(CaptionWordsFileSchema.parse({ words: [] })).toEqual({ words: [] })
  })

  it('accepts a list of words', () => {
    const value = { words: [{ word: 'hi', startSec: 0, endSec: 0.3 }] }
    expect(CaptionWordsFileSchema.parse(value)).toEqual(value)
  })
})
