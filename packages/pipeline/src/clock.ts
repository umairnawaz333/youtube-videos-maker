import type { Clock } from '@yt/core'

/**
 * The production Clock. This is the ONE place in engine code allowed to read the wall
 * clock; everywhere else takes an injected Clock so behaviour is deterministic in tests.
 */
export class SystemClock implements Clock {
  now(): Date {
    return new Date()
  }
}
