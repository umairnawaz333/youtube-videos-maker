import { describe, expect, it, vi } from 'vitest'
import { STAGE_REQUIREMENTS, type Stage, type StageOutcome, type RunContext } from '@yt/core'

/** A stage is only its name, its model requirement, and a run function. */
const buildStage = (outcome: StageOutcome): Stage => ({
  name: 'clip-gate',
  requires: STAGE_REQUIREMENTS['clip-gate'],
  run: vi.fn(async () => outcome),
})

describe('Stage contract', () => {
  it('lets a stage report completion', async () => {
    const stage = buildStage({ status: 'done' })
    await expect(stage.run({} as RunContext)).resolves.toEqual({ status: 'done' })
  })

  it('lets a stage pause the run for human input', async () => {
    const stage = buildStage({ status: 'paused', reason: 'awaiting_clips' })
    await expect(stage.run({} as RunContext)).resolves.toEqual({
      status: 'paused',
      reason: 'awaiting_clips',
    })
  })

  it('declares the clip gate as needing no model memory', () => {
    expect(buildStage({ status: 'done' }).requires).toBe('none')
  })
})

/**
 * Builds a fixture typed as exactly `RunContext['providers']` (i.e. `StageProviderBundle`).
 * Used only to exercise the type-level guarantees below; the mocked bodies are never
 * meant to reflect real provider behaviour.
 */
const buildStageProviders = (): RunContext['providers'] => ({
  llm: {
    complete: vi.fn(async () => 'ok'),
    json: vi.fn(async () => ({}) as never),
  },
  tts: { speak: vi.fn(async () => ({ outPath: '', durationSec: 0 })) },
  image: { generate: vi.fn(async () => ({ outPath: '' })) },
  clip: {
    request: vi.fn(async () => ({ status: 'ready' as const })),
    collect: vi.fn(async () => []),
  },
  caption: { transcribe: vi.fn(async () => []) },
  publish: { publish: vi.fn(async () => ({ videoId: '' })) },
  trend: { fetchCandidates: vi.fn(async () => []) },
})

describe('Stage contract - compile-time guarantees', () => {
  it('does not let a stage reach unload() on the llm or image provider', () => {
    // Regression this catches: if RunContext.providers is ever widened back to the full
    // ProviderBundle (Finding 1), `unload` becomes reachable again and these two lines
    // stop being type errors — the now-unused `@ts-expect-error` directives fail the build.
    const providers = buildStageProviders()
    // @ts-expect-error unload is not part of the llm provider a stage receives
    providers.llm.unload
    // @ts-expect-error unload is not part of the image provider a stage receives
    providers.image.unload
  })

  it('still lets a stage call llm.complete and image.generate', async () => {
    // Regression this catches: over-narrowing StageProviderBundle so that it drops
    // operational methods along with `unload` — these calls must keep type-checking
    // and keep working at runtime.
    const providers = buildStageProviders()
    await expect(providers.llm.complete('hi')).resolves.toBe('ok')
    await expect(
      providers.image.generate({ prompt: 'x', width: 1, height: 1, seed: 0, outPath: 'o' }),
    ).resolves.toEqual({ outPath: '' })
  })

  it('has exactly three StageOutcome variants', () => {
    // Regression this catches: adding or removing a StageOutcome variant without updating
    // every call site. The `never` assignment in the default branch only compiles when the
    // three explicit cases above it are exhaustive; add/remove a variant and this fails to build.
    const assertExhaustive = (outcome: StageOutcome): void => {
      switch (outcome.status) {
        case 'done':
          return
        case 'paused':
          return
        case 'halted':
          return
        default: {
          const _exhaustive: never = outcome
          void _exhaustive
        }
      }
    }
    expect(() => assertExhaustive({ status: 'done' })).not.toThrow()
  })
})
