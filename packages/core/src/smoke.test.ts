import { describe, expect, it } from 'vitest'
import { PACKAGE_NAME } from '@yt/core'

describe('workspace harness', () => {
  it('resolves the @yt/core alias', () => {
    expect(PACKAGE_NAME).toBe('@yt/core')
  })
})
