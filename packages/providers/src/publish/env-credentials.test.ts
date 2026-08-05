import { describe, expect, it } from 'vitest'
import { loadYoutubeCredentialsFromEnv } from './env-credentials'

describe('loadYoutubeCredentialsFromEnv', () => {
  it('reads the three required OAuth values from the given env', () => {
    const creds = loadYoutubeCredentialsFromEnv({
      YOUTUBE_CLIENT_ID: 'id-123',
      YOUTUBE_CLIENT_SECRET: 'secret-456',
      YOUTUBE_REFRESH_TOKEN: 'refresh-789',
    })

    expect(creds).toEqual({
      clientId: 'id-123',
      clientSecret: 'secret-456',
      refreshToken: 'refresh-789',
    })
  })

  it('throws a single error naming every missing variable, not just the first', () => {
    expect(() => loadYoutubeCredentialsFromEnv({})).toThrow(
      /YOUTUBE_CLIENT_ID.*YOUTUBE_CLIENT_SECRET.*YOUTUBE_REFRESH_TOKEN/s,
    )
  })

  it('points at .env.example in the error message so the owner knows where to look', () => {
    expect(() => loadYoutubeCredentialsFromEnv({})).toThrow(/\.env\.example/)
  })

  it('reports only the specific variables that are missing', () => {
    expect(() =>
      loadYoutubeCredentialsFromEnv({ YOUTUBE_CLIENT_ID: 'id-123', YOUTUBE_CLIENT_SECRET: 'secret-456' }),
    ).toThrow(/YOUTUBE_REFRESH_TOKEN/)
  })

  it('rejects blank values the same as missing ones', () => {
    expect(() =>
      loadYoutubeCredentialsFromEnv({
        YOUTUBE_CLIENT_ID: '   ',
        YOUTUBE_CLIENT_SECRET: 'secret-456',
        YOUTUBE_REFRESH_TOKEN: 'refresh-789',
      }),
    ).toThrow(/YOUTUBE_CLIENT_ID/)
  })
})
