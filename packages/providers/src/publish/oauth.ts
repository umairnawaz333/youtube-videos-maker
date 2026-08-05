import type { GoogleOAuthCredentials } from './env-credentials'

export interface OAuthTokenProvider {
  /** Returns a currently-valid access token, refreshing first if the cached one has expired. */
  getAccessToken(): Promise<string>
}

interface GoogleTokenResponse {
  access_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
/** Refresh this many seconds before the token's own reported expiry, so a slow subsequent
 * call never races an already-expired token. */
const EXPIRY_SAFETY_MARGIN_SEC = 60

export const createGoogleOAuthTokenProvider = (
  creds: GoogleOAuthCredentials,
  opts: { fetchImpl?: typeof fetch; tokenUrl?: string; now?: () => number } = {},
): OAuthTokenProvider => {
  const doFetch = opts.fetchImpl ?? fetch
  const tokenUrl = opts.tokenUrl ?? TOKEN_URL
  const now = opts.now ?? (() => Date.now())

  let cached: { token: string; expiresAtMs: number } | null = null

  const refresh = async (): Promise<{ token: string; expiresAtMs: number }> => {
    const body = new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token',
    })

    let res: Response
    try {
      res = await doFetch(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      })
    } catch (error) {
      // Same `.cause` unwrapping as packages/providers/src/ollama/client.ts: a bare fetch
      // TypeError's own message is an unhelpful "fetch failed".
      const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : ''
      const detail = error instanceof Error ? `${error.message}${cause}` : String(error)
      throw new Error(`cannot reach the Google OAuth token endpoint (${detail})`)
    }

    const json = (await res.json().catch(() => ({}))) as GoogleTokenResponse

    if (!res.ok || !json.access_token) {
      const reason = json.error
        ? `${json.error}${json.error_description ? `: ${json.error_description}` : ''}`
        : `HTTP ${res.status}`
      throw new Error(
        `YouTube OAuth token refresh failed (${reason}). If this is 'invalid_grant', the refresh ` +
          'token was revoked or expired — redo the consent flow described in .env.example and set ' +
          'YOUTUBE_REFRESH_TOKEN again.',
      )
    }

    return {
      token: json.access_token,
      expiresAtMs: now() + Math.max(0, (json.expires_in ?? 0) - EXPIRY_SAFETY_MARGIN_SEC) * 1000,
    }
  }

  return {
    async getAccessToken() {
      if (cached && cached.expiresAtMs > now()) return cached.token
      cached = await refresh()
      return cached.token
    },
  }
}
