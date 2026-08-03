import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG } from '@yt/core'
import { attemptsFor } from '@yt/pipeline'
import { fakeStage } from '../../../test/fixtures/stages'

const retries = DEFAULT_APP_CONFIG.retries

describe('attemptsFor', () => {
  it('gives LLM stages three attempts', () => {
    expect(attemptsFor(fakeStage('script-writer'), retries)).toBe(3)
  })

  it('gives network stages three attempts', () => {
    expect(attemptsFor(fakeStage('publisher'), retries)).toBe(3)
  })

  it('gives the render stage a single attempt', () => {
    expect(attemptsFor(fakeStage('editor'), retries)).toBe(1)
  })

  it('gives local stages a single attempt', () => {
    expect(attemptsFor(fakeStage('narrator'), retries)).toBe(1)
  })
})
