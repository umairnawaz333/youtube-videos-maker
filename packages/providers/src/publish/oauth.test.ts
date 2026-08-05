import { describe, expect, it, vi } from 'vitest'
import { createGoogleOAuthTokenProvider } from './oauth'

const creds = { clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh' }

const fakeFetch = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe('createGoogleOAuthTokenProvider', () => {
  it('exchanges the refresh token for an access token via a form-encoded POST', async () => {
    const fetchImpl = fakeFetch({ access_token: 'tok-1', expires_in: 3600 })
    const provider = createGoogleOAuthTokenProvider(creds, { fetchImpl })

    const token = await provider.getAccessToken()

    expect(token).toBe('tok-1')
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(call[0]).toBe('https://oauth2.googleapis.com/token')
    const init = call[1] as RequestInit
    expect(init.method).toBe('POST')
    const params = new URLSearchParams(init.body as string)
    expect(params.get('client_id')).toBe('id')
    expect(params.get('client_secret')).toBe('secret')
    expect(params.get('refresh_token')).toBe('refresh')
    expect(params.get('grant_type')).toBe('refresh_token')
  })

  it('never logs or throws the credential values themselves', async () => {
    const fetchImpl = fakeFetch({ error: 'invalid_grant' }, 400)
    const provider = createGoogleOAuthTokenProvider(creds, { fetchImpl })

    await expect(provider.getAccessToken()).rejects.toThrow(/invalid_grant|refresh/i)
    await expect(provider.getAccessToken()).rejects.not.toThrow(/secret|refresh-token-value/)
  })

  it('caches the token and does not re-fetch before it expires', async () => {
    const fetchImpl = fakeFetch({ access_token: 'tok-1', expires_in: 3600 })
    let now = 0
    const provider = createGoogleOAuthTokenProvider(creds, { fetchImpl, now: () => now })

    await provider.getAccessToken()
    now += 1000
    await provider.getAccessToken()

    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it('refreshes again once the cached token is near expiry', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: 'tok-2', expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch
    let now = 0
    const provider = createGoogleOAuthTokenProvider(creds, { fetchImpl, now: () => now })

    const first = await provider.getAccessToken()
    now += 3600_000 // a full hour later: well past expiry
    const second = await provider.getAccessToken()

    expect(first).toBe('tok-2')
    expect(second).toBe('tok-2')
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
  })

  it('throws a descriptive error when the token endpoint rejects the refresh token', async () => {
    const fetchImpl = fakeFetch({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400)
    const provider = createGoogleOAuthTokenProvider(creds, { fetchImpl })

    await expect(provider.getAccessToken()).rejects.toThrow(/invalid_grant/)
  })
})
