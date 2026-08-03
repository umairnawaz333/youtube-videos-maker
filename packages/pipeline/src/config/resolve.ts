import {
  AppConfigSchema,
  DEFAULT_APP_CONFIG,
  FORMAT_PRESETS,
  NicheConfigSchema,
  type AppConfig,
  type ResolvedConfig,
} from '@yt/core'

/** Drops undefined keys so an absent request field cannot blank a lower layer. */
const defined = <T extends object>(value: T | undefined): Partial<T> => {
  if (!value) return {}
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>
}

export interface ResolveConfigInput {
  request?: Partial<AppConfig>
  app?: unknown
  niche: unknown
}

/**
 * Precedence, leftmost wins: per-run request -> app.json -> niche config -> built-in default.
 */
export const resolveConfig = ({ request, app, niche }: ResolveConfigInput): ResolvedConfig => {
  const parsedNiche = NicheConfigSchema.safeParse(niche)
  if (!parsedNiche.success) {
    throw new Error(`niche config is invalid: ${JSON.stringify(parsedNiche.error.issues)}`)
  }

  const nicheLayer: Partial<AppConfig> = {
    niche: parsedNiche.data.id,
    voice: parsedNiche.data.voice,
  }

  let appLayer: Partial<AppConfig> = {}
  if (app !== undefined) {
    const parsedApp = AppConfigSchema.safeParse(app)
    if (!parsedApp.success) {
      throw new Error(`app config is invalid: ${JSON.stringify(parsedApp.error.issues)}`)
    }
    appLayer = parsedApp.data
  }

  const requestLayer = defined(request)

  const merged = {
    ...DEFAULT_APP_CONFIG,
    ...nicheLayer,
    ...appLayer,
    ...requestLayer,
    // Nested objects merge per key so a partial override keeps its siblings.
    clips: {
      ...DEFAULT_APP_CONFIG.clips,
      ...defined(appLayer.clips),
      ...defined(requestLayer.clips),
    },
    brandCorner: {
      ...DEFAULT_APP_CONFIG.brandCorner,
      ...defined(appLayer.brandCorner),
      ...defined(requestLayer.brandCorner),
    },
    retries: {
      ...DEFAULT_APP_CONFIG.retries,
      ...defined(appLayer.retries),
      ...defined(requestLayer.retries),
    },
  }

  const validated = AppConfigSchema.parse(merged)

  return {
    ...validated,
    nicheConfig: parsedNiche.data,
    preset: FORMAT_PRESETS[validated.videoType],
  }
}
