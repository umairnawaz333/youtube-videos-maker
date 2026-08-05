import { describe, expect, it } from 'vitest'
import { SystemClock } from '@yt/pipeline'

describe('SystemClock', () => {
  it('returns the current time', () => {
    const before = Date.now()
    const observed = new SystemClock().now().getTime()
    const after = Date.now()

    expect(observed).toBeGreaterThanOrEqual(before)
    expect(observed).toBeLessThanOrEqual(after)
  })

  it('advances between calls', async () => {
    const clock = new SystemClock()
    const first = clock.now().getTime()
    await new Promise((r) => setTimeout(r, 5))
    expect(clock.now().getTime()).toBeGreaterThan(first)
  })

  it('returns a fresh Date each call so a caller cannot mutate its state', () => {
    const clock = new SystemClock()
    const a = clock.now()
    a.setFullYear(1999)
    expect(clock.now().getFullYear()).toBeGreaterThan(2000)
  })
})
