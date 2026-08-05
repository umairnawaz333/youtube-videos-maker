export interface GoogleOAuthCredentials {
  clientId: string
  clientSecret: string
  refreshToken: string
}

const REQUIRED_VARS = ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN'] as const

type RequiredVar = (typeof REQUIRED_VARS)[number]

/**
 * Reads the three OAuth values a resumable YouTube upload needs, from environment variables
 * only — the repo must never contain a real credential. See `.env.example` for where these
 * come from (Google Cloud Console OAuth client + a one-time consent flow for the refresh
 * token) and this function's error, which repeats that pointer.
 *
 * Never logs a value, only variable names: a credential leaking into a log line is exactly
 * the kind of accident this exists to avoid.
 */
export const loadYoutubeCredentialsFromEnv = (
  env: Record<string, string | undefined> = process.env,
): GoogleOAuthCredentials => {
  const missing: RequiredVar[] = REQUIRED_VARS.filter((name) => !env[name] || env[name]!.trim() === '')

  if (missing.length > 0) {
    throw new Error(
      `missing YouTube publish credentials: ${missing.join(', ')}. ` +
        'See .env.example for what each one is and how to obtain it from Google Cloud Console.',
    )
  }

  return {
    clientId: env.YOUTUBE_CLIENT_ID!,
    clientSecret: env.YOUTUBE_CLIENT_SECRET!,
    refreshToken: env.YOUTUBE_REFRESH_TOKEN!,
  }
}
