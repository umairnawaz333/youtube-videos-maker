import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG, type AppConfig } from '@yt/core'
import { resolveConfig } from '@yt/pipeline'

const niche = {
  id: 'space',
  label: 'Space',
  promptGuidance: 'Explain one cosmic phenomenon.',
  voice: 'narrator-female',
  styleSuffix: 'cinematic astrophotography',
  music: 'ambient-drone',
  trendSources: ['wikipedia-top'],
  seoRules: 'Lead with the object.',
  monetizationRisk: 'low',
}

describe('resolveConfig precedence', () => {
  it('falls back to built-in defaults when nothing else supplies a value', () => {
    const resolved = resolveConfig({ niche })
    expect(resolved.language).toBe(DEFAULT_APP_CONFIG.language)
    expect(resolved.autoPublish).toBe(false)
  })

  it('lets the niche override the built-in default voice', () => {
    expect(resolveConfig({ niche }).voice).toBe('narrator-female')
  })

  it('lets app.json override the niche', () => {
    const resolved = resolveConfig({ niche, app: { ...DEFAULT_APP_CONFIG, voice: 'app-voice' } })
    expect(resolved.voice).toBe('app-voice')
  })

  it('lets a per-run request override everything', () => {
    const resolved = resolveConfig({
      niche,
      app: { ...DEFAULT_APP_CONFIG, voice: 'app-voice' },
      request: { voice: 'run-voice' },
    })
    expect(resolved.voice).toBe('run-voice')
  })

  it('ignores undefined request values rather than blanking the lower layer', () => {
    const resolved = resolveConfig({
      niche,
      app: { ...DEFAULT_APP_CONFIG, voice: 'app-voice' },
      request: { voice: undefined },
    })
    expect(resolved.voice).toBe('app-voice')
  })

  it('attaches the preset matching the resolved video type', () => {
    expect(resolveConfig({ niche, request: { videoType: 'shorts' } }).preset).toMatchObject({
      width: 1080,
      height: 1920,
    })
    expect(resolveConfig({ niche, request: { videoType: 'long' } }).preset).toMatchObject({
      width: 1920,
      height: 1080,
    })
  })

  it('attaches the parsed niche config', () => {
    expect(resolveConfig({ niche }).nicheConfig.id).toBe('space')
  })

  it('merges nested clip config per key instead of replacing the object', () => {
    const resolved = resolveConfig({
      niche,
      request: { clips: { ...DEFAULT_APP_CONFIG.clips, enabled: false } },
    })
    expect(resolved.clips.enabled).toBe(false)
    expect(resolved.clips.waitTimeoutHours).toBe(72)
  })

  it('rejects an invalid niche file with a readable error', () => {
    expect(() => resolveConfig({ niche: { id: 'broken' } })).toThrow(/niche config is invalid/)
  })

  it('rejects an invalid app config with a readable error', () => {
    expect(() => resolveConfig({ niche, app: { videoType: 'square' } })).toThrow(
      /app config is invalid/,
    )
  })

  it('rejects a resolved niche id that disagrees with the supplied niche config', () => {
    // niche argument is 'space', but the request asks to resolve as 'politics' -
    // the scalar `niche` field and `nicheConfig` would otherwise disagree.
    expect(() => resolveConfig({ niche, request: { niche: 'politics' } })).toThrow(
      /resolved niche 'politics' does not match the supplied niche config 'space'/,
    )
  })

  it('resolves normally when the request niche agrees with the supplied niche config', () => {
    const resolved = resolveConfig({ niche, request: { niche: 'space' } })
    expect(resolved.niche).toBe('space')
    expect(resolved.nicheConfig.id).toBe('space')
  })

  it('merges nested brandCorner config per key instead of replacing the object', () => {
    const resolved = resolveConfig({
      niche,
      request: { brandCorner: { enabled: false } as unknown as AppConfig['brandCorner'] },
    })
    expect(resolved.brandCorner.enabled).toBe(false)
    expect(resolved.brandCorner.position).toBe(DEFAULT_APP_CONFIG.brandCorner.position)
  })

  it('merges nested retries config per key instead of replacing the object', () => {
    const resolved = resolveConfig({
      niche,
      request: { retries: { network: 9 } as unknown as AppConfig['retries'] },
    })
    expect(resolved.retries.network).toBe(9)
    expect(resolved.retries.llm).toBe(DEFAULT_APP_CONFIG.retries.llm)
    expect(resolved.retries.render).toBe(DEFAULT_APP_CONFIG.retries.render)
    expect(resolved.retries.local).toBe(DEFAULT_APP_CONFIG.retries.local)
  })

  it('applies an app-layer nested override with siblings intact when the request is silent', () => {
    const resolved = resolveConfig({
      niche,
      app: {
        ...DEFAULT_APP_CONFIG,
        retries: { ...DEFAULT_APP_CONFIG.retries, network: 20 },
      },
    })
    expect(resolved.retries.network).toBe(20)
    expect(resolved.retries.llm).toBe(DEFAULT_APP_CONFIG.retries.llm)
    expect(resolved.retries.render).toBe(DEFAULT_APP_CONFIG.retries.render)
    expect(resolved.retries.local).toBe(DEFAULT_APP_CONFIG.retries.local)
  })

  it('lets the request win over the app layer on the same nested key while preserving each layer\'s untouched keys', () => {
    // app overrides llm and network; request overrides only network.
    // Expect: network from request (wins), llm from app (app-only key survives),
    // render/local untouched at their built-in defaults.
    const resolved = resolveConfig({
      niche,
      app: {
        ...DEFAULT_APP_CONFIG,
        retries: { ...DEFAULT_APP_CONFIG.retries, llm: 10, network: 20 },
      },
      request: { retries: { network: 99 } as unknown as AppConfig['retries'] },
    })
    expect(resolved.retries.network).toBe(99)
    expect(resolved.retries.llm).toBe(10)
    expect(resolved.retries.render).toBe(DEFAULT_APP_CONFIG.retries.render)
    expect(resolved.retries.local).toBe(DEFAULT_APP_CONFIG.retries.local)
  })
})
