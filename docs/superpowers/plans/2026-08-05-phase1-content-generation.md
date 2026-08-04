# AI YouTube Factory — Plan 2: Content Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the first six placeholder stages with real ones driven by a local language model, so a run produces a genuine researched, fact-checked script with a scene plan and scored SEO metadata on disk — still with no image model, no renderer, and no upload.

**Architecture:** Three fixes to the Plan 1 foundation first, because one of them changes the `Stage` contract and doing it later would touch every stage written in between. Then an Ollama adapter behind the existing `LlmProvider` interface and a keyless trend adapter behind `TrendProvider`. Then the six LLM-block stages, each a self-contained `Stage` that reads and writes schema-validated artifacts and never learns which model is behind the interface. Unit tests run against fakes in milliseconds; a separate opt-in integration suite exercises the real model.

**Tech Stack:** Node 26, TypeScript (CommonJS), pnpm workspaces, Zod, Prisma + SQLite, Vitest, Ollama (in-repo binary and weights).

**Source spec:** `docs/superpowers/specs/2026-08-01-ai-youtube-factory-mvp-design.md` §4 stages 1–6
**Carried-forward work:** `docs/superpowers/plans/PLAN-2-HANDOFF.md`

## Global Constraints

- **Zero paid services.** No hosted API, no cloud provider, nothing requiring billing or an API key.
- **All downloads stay in-repo.** The Ollama binary lives at `bin/ollama`, weights under `models/ollama` via `OLLAMA_MODELS`. Deleting the repo must fully revert the machine.
- **Only these pre-existing system tools may be assumed:** `ffmpeg`, `whisper-cli`, `node`, `python3`.
- **16 GB unified memory.** An 8B LLM (~6 GB), an image model (~8 GB), and a headless render browser (~3 GB) cannot be co-resident. Every heavy model is acquired through the `ModelBroker`. Never hold two.
- **Stage order is fixed** and grouped by model requirement: `topic-scout, researcher, script-writer, fact-checker, scene-planner, seo, illustrator, thumbnailer, narrator, captioner, clip-gate, editor, quality-gate, publisher`. Do not reorder.
- **No stage may import a concrete provider.** Everything goes through the interfaces in `@yt/core`. A stage cannot tell which model it is using.
- **Every stage writes artifacts to disk and records completion in SQLite**, so a killed run resumes from its last completed stage.
- **No `Date.now()` or `new Date()` in engine code.** Inject `Clock`. Prisma database-side `@default(now())` / `@updatedAt` on audit columns are permitted.
- **Story structure:** exactly 8 sections in order — `hook, question, conflict, curiosity, reveal, twist, conclusion, cta`. Beats within sections are 15–30 seconds each, schema-enforced.
- **Format presets:** `shorts` = 1080×1920, 45–60 s, 8–12 scenes, ~10 images, 2 clips. `long` = 1920×1080, 480–600 s, 60–90 scenes, ~70 images, 6 clips. Both H.264 @ 30 fps.
- **Config precedence:** per-run request → `app.json` → niche config → built-in default. Leftmost present value wins.
- **Metadata limits:** title ≤ 100 chars, description ≤ 5000 chars, tags ≤ 500 chars total.
- **Fact-check threshold:** halt the run if more than 15% of claims fail.
- **Retries:** LLM stages 3, network stages 3, render 1, all others 1.
- **The unit test suite runs with zero models loaded and completes in seconds.** Real-model tests are opt-in only, never part of `pnpm test`.
- **Outbound network is confined to two stages:** `topic-scout` and `researcher`. No other stage may make a network request.
- **Never scrub AI-product mentions from the spec** (e.g. "Claude, OpenAI, any hosted model" as swappable providers) — but never add AI authorship attribution to commits, branches, or PR text.

---

## What Plan 1 already provides

Do not rebuild any of this; import it.

**From `@yt/core`:** `STAGE_NAMES`, `StageName`, `ModelRequirement`, `STAGE_REQUIREMENTS`, `STAGE_RETRY_KIND`, `RUN_STATUSES`, `RunStatus`, `SECTION_KINDS`, `SectionKind`, `CAMERA_MOVES`, `CameraMove`, `VIDEO_FORMATS`, `VideoFormat`, `FormatPreset`, `FORMAT_PRESETS`; schemas `ResearchSchema`, `ScriptSchema`, `ScenePlanSchema`, `FactCheckSchema`, `SeoSchema`, `SceneVisualSchema`, `TitleCandidateSchema`, `BeatSchema`, `SectionSchema` with their inferred types; `MAX_TITLE_CHARS`, `MAX_DESCRIPTION_CHARS`, `MAX_TAGS_CHARS`, `MAX_FAILURE_RATIO`; config schemas `AppConfigSchema`, `NicheConfigSchema`, `ClipsConfigSchema`, `DEFAULT_APP_CONFIG`, `TREND_SOURCES`, `TrendSource`; interfaces `Clock`, `LlmProvider`, `TtsProvider`, `ImageProvider`, `ClipProvider`, `CaptionProvider`, `PublishProvider`, `TrendProvider`, `TopicCandidate`, `ProviderBundle`, `StageProviderBundle`, `PROVIDER_TOKENS`; and the stage contract `Stage`, `StageOutcome`, `RunContext`, `RunLogger`, `ArtifactName`, `ArtifactStore`, `RunPaths`, `TopicStore`, `ClipRequestStore`, `StoredClipRequest`, `ResolvedConfig`.

**From `@yt/providers`:** `createFakeProviders(opts?)`, `FixedClock`, `FakeCallLog`.

**From `@yt/db`:** `createPrismaClient`, `createRepositories`, `Repositories`, `RunRepository`, `TopicRepository`, `ClipRepository`, `JobRepository`, `ClaimedJob`, `StageRecord`.

**From `@yt/pipeline`:** `ModelBroker`, `Evictable`, `ModelLease`, `StageRunner`, `StageRunnerDeps`, `RunResult`, `attemptsFor`, `JobWorker`, `resolveConfig`, `loadConfig`, `listNiches`, `runPaths`, `ensureRunDirs`, `FileArtifactStore`, `EventRunLogger`, `LogEntry`, `buildDefaultChecks`, `runDoctor`, `nodeCommandRunner`, `nodeFsProbe`, `CommandRunner`, `FsProbe`, `DoctorCheck`, `DoctorReport`, `MIN_FREE_BYTES`, `buildNoopStages`, `runPipeline`, `RunPipelineOptions`.

**Key existing signatures this plan builds on, quoted exactly:**

```ts
export interface LlmProvider {
  complete(prompt: string, opts?: { temperature?: number; maxTokens?: number }): Promise<string>
  json<T>(prompt: string, schemaName: string, parse: (raw: unknown) => T): Promise<T>
  unload(): Promise<void>
}

export interface TopicCandidate {
  key: string
  title: string
  source: TrendSource
  url: string | null
}

export interface TrendProvider {
  fetchCandidates(sources: readonly TrendSource[]): Promise<TopicCandidate[]>
}

export interface Stage {
  name: StageName
  requires: ModelRequirement
  run(ctx: RunContext): Promise<StageOutcome>
}

export type StageOutcome =
  | { status: 'done' }
  | { status: 'paused'; reason: 'awaiting_clips' }
  | { status: 'halted'; reason: string }
```

`TREND_SOURCES` is `['wikipedia-top', 'hackernews', 'arxiv', 'reddit', 'google-trends']`.

`ArtifactName` is `'research' | 'script' | 'factcheck' | 'scenes' | 'seo' | 'videoSpec'`. **Note there is no `topic` artifact name** — Task 5 adds one.

---

## File Structure

**Modified in `packages/core`**
- `src/domain.ts` — add `'exclusive'` to `ModelRequirement`; retarget `STAGE_REQUIREMENTS` entries that need it
- `src/stage.ts` — add `'topic'` to `ArtifactName`
- `src/schemas/content.ts` — add `TopicSchema` (the selected topic artifact) and `TopicCandidateScoreSchema`
- `src/schemas/config.ts` — add `llm` settings block to `AppConfigSchema`; add `backoffMs` to `RetryConfigSchema`

**Modified in `packages/pipeline`**
- `src/model-broker.ts` — honour `'exclusive'` by evicting whatever is resident
- `src/stage-runner.ts` — validate `deps.stages` ordering/completeness; apply retry backoff
- `src/clock.ts` — NEW: `SystemClock`
- `src/cli.ts` — accept an injected `clock`; wire the six real stages

**New in `packages/providers`**
- `src/ollama/client.ts` — thin HTTP client for a locally-served Ollama (generate, and a keep-alive-zero unload)
- `src/ollama/llm-provider.ts` — `OllamaLlmProvider implements LlmProvider`, including the JSON retry loop
- `src/trends/sources.ts` — one keyless fetcher per `TrendSource`
- `src/trends/trend-provider.ts` — `HttpTrendProvider implements TrendProvider`
- `src/index.ts` — re-exports

**New in `packages/pipeline/src/stages/`** — one file per stage, each exporting a factory
- `topic-scout.ts`, `researcher.ts`, `script-writer.ts`, `fact-checker.ts`, `scene-planner.ts`, `seo.ts`
- `prompts/` — one prompt builder per stage, kept separate from orchestration so prompts can be tuned without touching stage logic
- `index.ts` — `buildLlmStages()` returning the six in canonical order

**New tooling**
- `scripts/setup-ollama.sh` — reproducible in-repo install
- `test/integration/llm.integration.test.ts` — opt-in, real model

---

### Task 1: The `'exclusive'` model requirement

Closes the spec gap recorded in the handoff: nothing could evict the image model before rendering, so an 8 GB image model would stay resident through narration, captioning and a headless browser render. Doing this first means `Stage.requires` changes once, before six new stages exist.

**Files:**
- Modify: `packages/core/src/domain.ts`
- Modify: `packages/core/src/domain.test.ts`
- Modify: `packages/pipeline/src/model-broker.ts`
- Modify: `packages/pipeline/src/model-broker.test.ts`

**Interfaces:**
- Consumes: `ModelRequirement`, `STAGE_REQUIREMENTS` (Plan 1)
- Produces: `ModelRequirement` widened to `'llm' | 'sd' | 'none' | 'exclusive'`; `STAGE_REQUIREMENTS` with `narrator` and `editor` set to `'exclusive'`; `ModelBroker.acquire('exclusive')` evicting whatever is resident and leaving nothing resident.

**Why `narrator` and `editor` specifically:** `narrator` is the first stage after the image block, so marking it exclusive is what forces the image model out before the small-model block begins. `editor` declares the same need because a headless browser render must not share memory with anything. Nothing between them re-loads a heavy model, so the second exclusive acquisition evicts nothing — the run still performs exactly two unloads, just at the right moments.

- [ ] **Step 1: Update the domain test to assert the real memory property**

The existing test asserts the compacted requirement sequence equals `['llm','sd','none']`. That encoding no longer describes the design. Replace that single test with these two in `packages/core/src/domain.test.ts` (keep every other test in the file unchanged):

```ts
  it('forces the image model out before the small-model block begins', () => {
    // narrator is the first stage after the SD block. Marking it exclusive is what
    // evicts SDXL before narration, captioning and the Chromium render run.
    expect(STAGE_REQUIREMENTS.narrator).toBe('exclusive')
    expect(STAGE_REQUIREMENTS.editor).toBe('exclusive')
  })

  it('keeps the requirement sequence grouped so heavy models load at most once each', () => {
    const sequence = STAGE_NAMES.map((n) => STAGE_REQUIREMENTS[n])
    // Each heavy model appears in exactly one contiguous run.
    for (const heavy of ['llm', 'sd'] as const) {
      const indices = sequence.flatMap((req, i) => (req === heavy ? [i] : []))
      expect(indices.length).toBeGreaterThan(0)
      const contiguous = indices.every((idx, k) => k === 0 || idx === indices[k - 1]! + 1)
      expect(contiguous, `${heavy} requirements must be contiguous`).toBe(true)
    }
    // No heavy requirement may appear after the first exclusive stage.
    const firstExclusive = sequence.indexOf('exclusive')
    expect(firstExclusive).toBeGreaterThan(0)
    expect(sequence.slice(firstExclusive)).not.toContain('llm')
    expect(sequence.slice(firstExclusive)).not.toContain('sd')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/domain.test.ts`
Expected: FAIL — `STAGE_REQUIREMENTS.narrator` is `'none'`, not `'exclusive'`.

- [ ] **Step 3: Widen the type and retarget the two stages**

In `packages/core/src/domain.ts`, replace the `ModelRequirement` type and the two entries:

```ts
/**
 * 'exclusive' means "evict whatever is resident before me — I need the memory to
 * myself". It is how the render and narration block force the image model out; without
 * it an 8 GB image model would still be resident when a headless browser starts.
 */
export type ModelRequirement = 'llm' | 'sd' | 'none' | 'exclusive'
```

Then in `STAGE_REQUIREMENTS` change exactly two lines:

```ts
  narrator: 'exclusive',
  captioner: 'none',
  'clip-gate': 'none',
  editor: 'exclusive',
```

- [ ] **Step 4: Run the domain tests**

Run: `pnpm vitest run packages/core/src/domain.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing broker tests**

Append to `packages/pipeline/src/model-broker.test.ts`:

```ts
describe('ModelBroker exclusive requirement', () => {
  it('evicts the resident model and leaves nothing resident', async () => {
    const llm = evictable('llm')
    const sd = evictable('sd')
    const broker = new ModelBroker([llm.evictable, sd.evictable])

    ;(await broker.acquire('sd')).release()
    expect(broker.resident).toBe('sd')

    const lease = await broker.acquire('exclusive')
    expect(sd.unload).toHaveBeenCalledTimes(1)
    expect(broker.resident).toBeNull()
    lease.release()
  })

  it('is a no-op eviction when nothing is resident', async () => {
    const llm = evictable('llm')
    const broker = new ModelBroker([llm.evictable])

    ;(await broker.acquire('exclusive')).release()

    expect(llm.unload).not.toHaveBeenCalled()
    expect(broker.resident).toBeNull()
  })

  it('queues behind a held lease rather than evicting underneath it', async () => {
    const llm = evictable('llm')
    const broker = new ModelBroker([llm.evictable])
    const observed: string[] = []

    const held = await broker.acquire('llm')
    const exclusive = broker.acquire('exclusive').then((lease) => {
      observed.push('exclusive-admitted')
      lease.release()
    })

    await new Promise((r) => setTimeout(r, 10))
    observed.push('still-holding-llm')
    expect(broker.resident).toBe('llm')
    held.release()
    await exclusive

    expect(observed).toEqual(['still-holding-llm', 'exclusive-admitted'])
    expect(broker.resident).toBeNull()
  })

  it('does not deadlock when the eviction it triggers rejects', async () => {
    const failing: Evictable = { id: 'sd', unload: async () => { throw new Error('sd unload failed') } }
    const llm = evictable('llm')
    const broker = new ModelBroker([failing, llm.evictable])

    ;(await broker.acquire('sd')).release()
    await expect(broker.acquire('exclusive')).rejects.toThrow('sd unload failed')

    // The lock must have been released, so the broker is still usable.
    const after = await broker.acquire('llm')
    expect(broker.resident).toBe('llm')
    after.release()
  })

  it('performs exactly two unloads across the full stage sequence, with SD gone before narration', async () => {
    const llm = evictable('llm')
    const sd = evictable('sd')
    const broker = new ModelBroker([llm.evictable, sd.evictable])
    let residentAtNarrator: string | null = 'unset' as unknown as string | null

    for (const name of STAGE_NAMES) {
      const lease = await broker.acquire(STAGE_REQUIREMENTS[name])
      if (name === 'narrator') residentAtNarrator = broker.resident
      lease.release()
    }

    expect(llm.unload).toHaveBeenCalledTimes(1)
    expect(sd.unload).toHaveBeenCalledTimes(1)
    // The whole point: no heavy model is resident once narration starts.
    expect(residentAtNarrator).toBeNull()
    await broker.evictAll()
    expect(broker.resident).toBeNull()
  })
})
```

Add `STAGE_NAMES, STAGE_REQUIREMENTS` to the existing `@yt/core` import in that test file, and `type Evictable` if it is not already imported.

**Note:** the pre-existing test named `'performs exactly two evictions across the full stage sequence'` hardcodes a 14-element requirement array that no longer matches `STAGE_REQUIREMENTS`. Delete that one test — the new test above supersedes it by driving the real map. Leave the other original broker tests untouched.

- [ ] **Step 6: Run the broker tests to verify they fail**

Run: `pnpm vitest run packages/pipeline/src/model-broker.test.ts`
Expected: FAIL — `acquire('exclusive')` throws `no evictable registered for 'exclusive'`.

- [ ] **Step 7: Teach the broker about `'exclusive'`**

In `packages/pipeline/src/model-broker.ts`, replace the body of `acquire` between the `'none'` short-circuit and the queue with this. The `'none'` short-circuit, the FIFO chain, and the `catch`-release-rethrow all stay exactly as they are:

```ts
  async acquire(requirement: ModelRequirement): Promise<ModelLease> {
    // A stage needing no model must not queue behind model work.
    if (requirement === 'none') {
      return { release: () => {} }
    }

    // 'exclusive' has no evictable of its own — it means "evict whatever is resident
    // and run with the memory to yourself". It still queues, because it mutates residency.
    if (requirement !== 'exclusive' && !this.evictables.has(requirement)) {
      throw new Error(`ModelBroker: no evictable registered for '${requirement}'`)
    }

    let releaseLock!: () => void
    const held = new Promise<void>((resolve) => {
      releaseLock = resolve
    })

    const waitFor = this.tail
    this.tail = waitFor.then(() => held)
    await waitFor

    try {
      if (requirement === 'exclusive') {
        // Evict the incumbent and stay at null: nothing is resident for this stage.
        if (this.current !== null) {
          const incumbent = this.evictables.get(this.current)
          if (incumbent) await incumbent.unload()
          this.current = null
        }
      } else {
        if (this.current !== null && this.current !== requirement) {
          const incumbent = this.evictables.get(this.current)
          if (incumbent) await incumbent.unload()
          this.current = null
        }
        this.current = requirement
      }
    } catch (error) {
      // Release before rethrowing, or `tail` waits on a promise that never settles and
      // every later acquire hangs. Must NOT be a bare finally: that would drop the lock
      // while the caller still holds the lease.
      releaseLock()
      throw error
    }

    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        releaseLock()
      },
    }
  }
```

Note `this.current` is typed `'llm' | 'sd' | null`, so assigning `requirement` in the else branch requires narrowing — declare the else branch's requirement as `Exclude<ModelRequirement, 'none' | 'exclusive'>` via a local const if TypeScript complains, rather than casting to `any`.

- [ ] **Step 8: Run the full suite**

Run: `pnpm test`
Expected: PASS. If the stage-runner tests fail, it is because one of them asserts the old eviction ordering — read the failure and update only the assertion that encodes the superseded behaviour, keeping its intent.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src packages/pipeline/src
git commit -m "feat(core): add exclusive model requirement so the image model is evicted before rendering"
```

---

### Task 2: A real clock

`FixedClock` is currently the only `Clock` implementation and `runPipeline` hardcodes it, so every production run stamps an identical timestamp, `startedAt` always equals `endedAt`, and the 72-hour clip-wait timeout is unimplementable. The composition root also imports its production clock from the *fakes* package, which is backwards.

**Files:**
- Create: `packages/pipeline/src/clock.ts`
- Create: `packages/pipeline/src/clock.test.ts`
- Modify: `packages/pipeline/src/index.ts` (append one export line)
- Modify: `packages/pipeline/src/cli.ts`
- Modify: `test/e2e/fake-pipeline.test.ts`

**Interfaces:**
- Consumes: `Clock` from `@yt/core`
- Produces: `SystemClock` (class implementing `Clock`) exported from `@yt/pipeline`; `RunPipelineOptions` gains `clock?: Clock`.

- [ ] **Step 1: Write the failing test**

Create `packages/pipeline/src/clock.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/pipeline/src/clock.test.ts`
Expected: FAIL — `SystemClock` is not exported from `@yt/pipeline`.

- [ ] **Step 3: Write the implementation**

Create `packages/pipeline/src/clock.ts`:

```ts
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
```

Append to `packages/pipeline/src/index.ts`:

```ts
export * from './clock'
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run packages/pipeline/src/clock.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Make the clock injectable and default the CLI to the real one**

In `packages/pipeline/src/cli.ts`:

Add to the `RunPipelineOptions` interface:

```ts
  /** Defaults to SystemClock. Tests pass a FixedClock for determinism. */
  clock?: Clock
```

Import `SystemClock` from `'./clock'` and `type Clock` from `@yt/core`, then replace the hardcoded clock construction with:

```ts
  const clock = opts.clock ?? new SystemClock()
```

Delete the now-unused `FixedClock` import and the `nowIso` option if present, along with any code that reads it. **`runPipeline` must no longer import anything from `@yt/providers` for its clock** — a production composition root importing its clock from a fakes package is the defect being fixed.

- [ ] **Step 6: Pin the e2e tests to a fixed clock**

In `test/e2e/fake-pipeline.test.ts`, every `runPipeline(...)` call must now pass an explicit clock so the tests stay deterministic. Add to each options object:

```ts
      clock: new FixedClock('2026-08-01T10:00:00.000Z'),
```

and import `FixedClock` from `@yt/providers` in that test file if it is not already imported.

- [ ] **Step 7: Add a test proving the default is real, not fixed**

Append to `test/e2e/fake-pipeline.test.ts`:

```ts
  it('defaults to a real clock so production runs get real timestamps', async () => {
    const before = Date.now()
    await runPipeline({
      runId: 'run-clock',
      repos,
      configDir,
      storageRoot,
      request: { niche: 'space', videoType: 'shorts' },
      useFakes: true,
      // deliberately no clock
    })
    const run = await repos.runs.get('run-clock')
    const createdAt = run!.createdAt.getTime()

    expect(createdAt).toBeGreaterThanOrEqual(before)
    expect(createdAt).toBeLessThanOrEqual(Date.now())
  })
```

- [ ] **Step 8: Run the full suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/pipeline/src test/e2e
git commit -m "feat(pipeline): add SystemClock and make the run clock injectable"
```

---

### Task 3: Stage-list validation and retry backoff

Two carried-forward gaps. `StageRunner`'s resume logic assumes the caller passes stages in `STAGE_NAMES` order — a reordered or partial array silently changes which stages resume, which becomes dangerous the moment this plan starts passing custom stage arrays. And retries currently have zero delay, though spec §8 promises backoff for network stages; instant triple-retry against a local model server or a rate-limited public API just burns the attempt budget.

**Files:**
- Modify: `packages/core/src/schemas/config.ts` (add `backoffMs` to `RetryConfigSchema` and `DEFAULT_APP_CONFIG`)
- Modify: `config/app.json`
- Modify: `packages/pipeline/src/stage-runner.ts`
- Modify: `packages/pipeline/src/stage-runner.test.ts`

**Interfaces:**
- Consumes: `RetryConfig`, `STAGE_NAMES`, `STAGE_RETRY_KIND` (Plan 1)
- Produces: `RetryConfigSchema` gains `backoffMs: { llm, network, render, local }`; `StageRunnerDeps` gains optional `sleep?: (ms: number) => Promise<void>`; `StageRunner` constructor throws on a malformed stage list.

- [ ] **Step 1: Write the failing tests**

Append to `packages/pipeline/src/stage-runner.test.ts`:

```ts
describe('StageRunner stage-list validation', () => {
  it('rejects a stage list in the wrong order', () => {
    const reordered = [...STAGE_NAMES].reverse().map((n) => fakeStage(n))
    expect(() => runner(reordered)).toThrow(/order/i)
  })

  it('rejects a stage list with a duplicate', () => {
    const withDuplicate = [...STAGE_NAMES.map((n) => fakeStage(n)), fakeStage('seo')]
    expect(() => runner(withDuplicate)).toThrow(/duplicate/i)
  })

  it('rejects a stage whose requires disagrees with the canonical map', () => {
    const stages = STAGE_NAMES.map((n) => fakeStage(n))
    stages[0] = { ...stages[0]!, requires: 'sd' }
    expect(() => runner(stages)).toThrow(/requires/i)
  })

  it('accepts a leading prefix of the canonical order, so a partial pipeline is runnable', () => {
    // This plan runs only the six LLM stages until later plans add the rest.
    const prefix = STAGE_NAMES.slice(0, 6).map((n) => fakeStage(n))
    expect(() => runner(prefix)).not.toThrow()
  })
})

describe('StageRunner retry backoff', () => {
  it('waits between attempts using the configured backoff for the stage kind', async () => {
    const slept: number[] = []
    const stages = STAGE_NAMES.map((n) =>
      n === 'topic-scout' ? fakeStage(n, { failTimes: 2 }) : fakeStage(n),
    )
    const r = new StageRunner({
      stages,
      broker,
      repos,
      clock: new FixedClock('2026-08-01T10:00:00.000Z'),
      sleep: async (ms) => {
        slept.push(ms)
      },
    })

    const result = await r.execute(context())

    expect(result.status).toBe('awaiting_review')
    // topic-scout is a 'network' stage: 3 attempts means 2 waits, growing.
    expect(slept).toHaveLength(2)
    expect(slept[0]).toBe(DEFAULT_APP_CONFIG.retries.backoffMs.network)
    expect(slept[1]).toBe(DEFAULT_APP_CONFIG.retries.backoffMs.network * 2)
  })

  it('does not wait after the final attempt', async () => {
    const slept: number[] = []
    const stages = STAGE_NAMES.map((n) =>
      n === 'editor' ? fakeStage(n, { failTimes: 99 }) : fakeStage(n),
    )
    const r = new StageRunner({
      stages,
      broker,
      repos,
      clock: new FixedClock('2026-08-01T10:00:00.000Z'),
      sleep: async (ms) => {
        slept.push(ms)
      },
    })

    await r.execute(context())

    // editor is a 'render' stage with 1 attempt, so there is nothing to wait for.
    expect(slept).toEqual([])
  })
})
```

Add `DEFAULT_APP_CONFIG` and `STAGE_NAMES` to the `@yt/core` import in that file if not already present.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run packages/pipeline/src/stage-runner.test.ts`
Expected: FAIL — the constructor does not validate, and `backoffMs` does not exist on `RetryConfig`.

- [ ] **Step 3: Add `backoffMs` to the config schema**

In `packages/core/src/schemas/config.ts`, replace `RetryConfigSchema` with:

```ts
export const RetryConfigSchema = z.object({
  llm: z.number().int().min(1),
  network: z.number().int().min(1),
  render: z.number().int().min(1),
  local: z.number().int().min(1),
  /**
   * Base delay before a retry, doubling each attempt. Spec section 8 promises backoff for
   * network stages; retrying a rate-limited endpoint instantly just burns the budget.
   */
  backoffMs: z.object({
    llm: z.number().int().nonnegative(),
    network: z.number().int().nonnegative(),
    render: z.number().int().nonnegative(),
    local: z.number().int().nonnegative(),
  }),
})
```

In `DEFAULT_APP_CONFIG`, replace the `retries` value with:

```ts
  retries: {
    llm: 3,
    network: 3,
    render: 1,
    local: 1,
    backoffMs: { llm: 500, network: 2000, render: 0, local: 0 },
  },
```

And in `config/app.json`, replace the `"retries"` value with:

```json
  "retries": {
    "llm": 3,
    "network": 3,
    "render": 1,
    "local": 1,
    "backoffMs": { "llm": 500, "network": 2000, "render": 0, "local": 0 }
  },
```

- [ ] **Step 4: Add validation and backoff to the runner**

In `packages/pipeline/src/stage-runner.ts`, add to `StageRunnerDeps`:

```ts
  /** Injected so backoff is instant in tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
```

Add a constructor that validates the stage list. Replace `constructor(private readonly deps: StageRunnerDeps) {}` with:

```ts
  constructor(private readonly deps: StageRunnerDeps) {
    const names = deps.stages.map((s) => s.name)

    const seen = new Set<StageName>()
    for (const name of names) {
      if (seen.has(name)) {
        throw new Error(`StageRunner: duplicate stage '${name}' in the stage list`)
      }
      seen.add(name)
    }

    // Resume correctness depends on the list being a leading prefix of the canonical
    // order: `completedStages` is matched by name, so a reordered or gapped list would
    // silently change which stages are skipped on resume.
    const expected = STAGE_NAMES.slice(0, names.length)
    if (names.join('|') !== expected.join('|')) {
      throw new Error(
        `StageRunner: stages must be a leading prefix of the canonical order. ` +
          `Expected ${expected.join(', ')} but got ${names.join(', ')}`,
      )
    }

    for (const stage of deps.stages) {
      if (stage.requires !== STAGE_REQUIREMENTS[stage.name]) {
        throw new Error(
          `StageRunner: stage '${stage.name}' declares requires='${stage.requires}' but the ` +
            `canonical map says '${STAGE_REQUIREMENTS[stage.name]}'. The memory grouping ` +
            `depends on these agreeing.`,
        )
      }
    }
  }
```

Import `STAGE_NAMES` and `STAGE_REQUIREMENTS` as values (not just types) from `@yt/core`.

Then in `runWithRetry`, after a failed attempt and only when another attempt remains, wait:

```ts
      const backoff = ctx.config.retries.backoffMs[STAGE_RETRY_KIND[stage.name]]
      if (attempt < maxAttempts && backoff > 0) {
        const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
        // Doubling: attempt 1 waits `backoff`, attempt 2 waits `backoff * 2`.
        await sleep(backoff * 2 ** (attempt - 1))
      }
```

Place this at the end of the `catch` block, after `failStage`, so a stage that succeeds never waits. Import `STAGE_RETRY_KIND` as a value.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: PASS. The `niche-files.test.ts` and `config.test.ts` tests will exercise the new `backoffMs` shape via `app.json`; if either fails, the JSON and the schema disagree — fix the JSON, not the schema.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src packages/pipeline/src config/app.json
git commit -m "feat(pipeline): validate the stage list and add retry backoff"
```

---

### Task 4: In-repo Ollama setup

Everything must live inside the repo so deleting it reverts the machine. A prefetch has likely already placed `bin/ollama` and pulled a model into `models/ollama` — this task makes that reproducible, documented, and verified rather than accidental.

**Files:**
- Create: `scripts/setup-ollama.sh`
- Create: `docs/setup.md`
- Modify: `package.json` (add `ollama:serve` and `ollama:setup` scripts)
- Modify: `.env.example` (document `OLLAMA_HOST` and `LLM_MODEL`)

**Interfaces:**
- Consumes: nothing
- Produces: `bin/ollama` executable; weights under `models/ollama`; `pnpm ollama:serve` starting a server with `OLLAMA_MODELS` pointed in-repo; `pnpm ollama:setup` being idempotent.

- [ ] **Step 1: Check what the prefetch already produced**

Run:
```bash
ls -la bin/ollama 2>/dev/null; du -sh models/ollama 2>/dev/null
OLLAMA_MODELS="$PWD/models/ollama" ./bin/ollama serve >/tmp/ollama.log 2>&1 &
sleep 5; OLLAMA_MODELS="$PWD/models/ollama" ./bin/ollama list; kill %1
```
Record the actual output in your report — the installed model's exact tag is what Task 5's default must match. If no model is present, the setup script below pulls one.

- [ ] **Step 2: Write the setup script**

Create `scripts/setup-ollama.sh`:

```bash
#!/usr/bin/env bash
# Installs Ollama and one language model ENTIRELY INSIDE THIS REPO, so that deleting the
# repo fully reverts the machine. Idempotent: safe to re-run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
mkdir -p bin models/ollama
export OLLAMA_MODELS="$REPO_ROOT/models/ollama"

MODEL="${LLM_MODEL:-qwen3:8b}"

if [ ! -x bin/ollama ]; then
  echo "--> downloading ollama (darwin) into bin/"
  curl -fL --retry 3 -o /tmp/ollama-darwin.tgz \
    https://github.com/ollama/ollama/releases/latest/download/ollama-darwin.tgz
  tar -xzf /tmp/ollama-darwin.tgz -C bin/
  if [ ! -x bin/ollama ]; then
    found="$(find bin -type f -name ollama | head -1)"
    [ -n "$found" ] && mv "$found" bin/ollama
  fi
  chmod +x bin/ollama
  rm -f /tmp/ollama-darwin.tgz
fi
echo "--> ollama: $(bin/ollama --version 2>&1 | head -1)"

echo "--> starting a temporary server"
bin/ollama serve >/tmp/ollama-setup.log 2>&1 &
SERVE_PID=$!
trap 'kill "$SERVE_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  bin/ollama list >/dev/null 2>&1 && break
  sleep 1
done
bin/ollama list >/dev/null 2>&1 || { echo "server failed to start; see /tmp/ollama-setup.log" >&2; exit 1; }

if bin/ollama list | awk 'NR>1 {print $1}' | grep -qx "$MODEL"; then
  echo "--> $MODEL already present"
else
  echo "--> pulling $MODEL (several GB; this is the slow part)"
  bin/ollama pull "$MODEL"
fi

echo "--> installed models:"
bin/ollama list
echo "--> weights on disk: $(du -sh models/ollama | cut -f1)"
echo "--> smoke test"
bin/ollama run "$MODEL" 'Reply with exactly the word: READY'
echo "done. Start a server for development with: pnpm ollama:serve"
```

Make it executable: `chmod +x scripts/setup-ollama.sh`.

- [ ] **Step 3: Add the scripts**

In the root `package.json`, add to `"scripts"`:

```json
    "ollama:setup": "bash scripts/setup-ollama.sh",
    "ollama:serve": "OLLAMA_MODELS=\"$PWD/models/ollama\" ./bin/ollama serve",
```

- [ ] **Step 4: Document the two new environment variables**

Append to `.env.example`:

```bash
# Where the locally-served Ollama listens. The provider never starts a server itself;
# run `pnpm ollama:serve` in another terminal first.
OLLAMA_HOST="http://127.0.0.1:11434"
# Model tag used by the LLM stages. Must be present in `bin/ollama list`.
LLM_MODEL="qwen3:8b"
```

- [ ] **Step 5: Write the setup documentation**

Create `docs/setup.md`:

```markdown
# Local setup

Everything this project downloads lives inside the repo. Deleting the repo reverts the machine.

## Prerequisites (system-wide, already present on the target machine)

`node` (26+), `pnpm`, `python3`, `ffmpeg`, `whisper-cli`. Nothing else is assumed.

## One-time

```bash
pnpm install
pnpm --filter @yt/db db:generate
DATABASE_URL="file:../../../storage/factory.db" pnpm --filter @yt/db db:push
pnpm ollama:setup     # installs bin/ollama and pulls the model into models/ollama
pnpm check            # preflight: every dependency and model
```

`pnpm check` is the doctor. It exits non-zero when a **required** check fails; missing model
weights only warn. Note `pnpm doctor` does NOT work — it collides with pnpm's own built-in
`doctor` subcommand, which is why the alias exists.

## Running

```bash
pnpm ollama:serve            # terminal 1 — the model server
pnpm pipeline:run my-run-1   # terminal 2 — the pipeline
```

Re-running the same run id resumes from the last completed stage instead of restarting.

## Tests

```bash
pnpm test              # unit + e2e against fakes; no models loaded; ~2s
pnpm test:integration  # opt-in, exercises the real model; requires ollama:serve
```
```

- [ ] **Step 6: Verify the setup script is idempotent**

Run: `pnpm ollama:setup`
Expected: reports the model already present, does not re-download, prints `READY` from the smoke test. Record the output.

Run: `pnpm check`
Expected: `ollama binary` now PASSES (it did not before), `LLM weights` now PASSES, and the overall exit code is 0 if all required checks pass. Record the output and exit code — this is the first time the doctor should be green.

- [ ] **Step 7: Commit**

```bash
git add scripts/setup-ollama.sh docs/setup.md package.json .env.example
git commit -m "feat(setup): add reproducible in-repo ollama setup and setup docs"
```

---

### Task 5: The Ollama LLM provider

**Files:**
- Create: `packages/providers/src/ollama/client.ts`
- Create: `packages/providers/src/ollama/llm-provider.ts`
- Create: `packages/providers/src/ollama/llm-provider.test.ts`
- Modify: `packages/providers/src/index.ts`

**Interfaces:**
- Consumes: `LlmProvider` from `@yt/core`
- Produces:
  - `interface OllamaClient { generate(req: OllamaGenerateRequest): Promise<string>; unload(model: string): Promise<void> }`
  - `interface OllamaGenerateRequest { model: string; prompt: string; json: boolean; temperature?: number; maxTokens?: number }`
  - `createHttpOllamaClient(opts: { host: string; fetchImpl?: typeof fetch }): OllamaClient`
  - `class OllamaLlmProvider implements LlmProvider` — `constructor(deps: { client: OllamaClient; model: string; jsonAttempts?: number; log?: (message: string) => void })`
  - Both exported from `@yt/providers`.

**Design notes that matter:**
- `json<T>` must retry until the response parses AND the caller's `parse` accepts it, because the interface's contract is that stages never see malformed JSON. Default 3 attempts. On the final failure, throw an error naming the `schemaName` and including the last raw response truncated to 500 characters — a stage author debugging a bad prompt needs to see what the model actually said.
- Local models often wrap JSON in prose or a ```json fence even when asked not to. Strip a fenced block and take the outermost `{...}` or `[...]` span before parsing.
- `unload()` posts `keep_alive: 0`, which is how Ollama releases model memory. This is the method the `ModelBroker` calls; nothing else may call it.
- The provider never starts a server. If the host is unreachable, the error must say to run `pnpm ollama:serve`.

- [ ] **Step 1: Write the failing test**

Create `packages/providers/src/ollama/llm-provider.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { OllamaLlmProvider, type OllamaClient, type OllamaGenerateRequest } from '@yt/providers'

const clientReturning = (...responses: string[]): OllamaClient & { calls: OllamaGenerateRequest[] } => {
  const calls: OllamaGenerateRequest[] = []
  let i = 0
  return {
    calls,
    async generate(req) {
      calls.push(req)
      return responses[Math.min(i++, responses.length - 1)]!
    },
    async unload() {},
  }
}

describe('OllamaLlmProvider.complete', () => {
  it('returns the model text and does not request JSON mode', async () => {
    const client = clientReturning('a plain answer')
    const provider = new OllamaLlmProvider({ client, model: 'test-model' })

    await expect(provider.complete('hello')).resolves.toBe('a plain answer')
    expect(client.calls[0]).toMatchObject({ model: 'test-model', prompt: 'hello', json: false })
  })

  it('passes temperature and maxTokens through', async () => {
    const client = clientReturning('x')
    const provider = new OllamaLlmProvider({ client, model: 'test-model' })

    await provider.complete('hello', { temperature: 0.2, maxTokens: 64 })

    expect(client.calls[0]).toMatchObject({ temperature: 0.2, maxTokens: 64 })
  })
})

describe('OllamaLlmProvider.json', () => {
  const parseThing = (raw: unknown) => {
    const v = raw as { ok?: boolean }
    if (typeof v?.ok !== 'boolean') throw new Error('missing ok')
    return { ok: v.ok }
  }

  it('parses a clean JSON response and asks for JSON mode', async () => {
    const client = clientReturning('{"ok":true}')
    const provider = new OllamaLlmProvider({ client, model: 'm' })

    await expect(provider.json('p', 'Thing', parseThing)).resolves.toEqual({ ok: true })
    expect(client.calls[0]!.json).toBe(true)
  })

  it('recovers JSON wrapped in a fenced code block', async () => {
    const client = clientReturning('Sure!\n```json\n{"ok":false}\n```\nHope that helps.')
    const provider = new OllamaLlmProvider({ client, model: 'm' })

    await expect(provider.json('p', 'Thing', parseThing)).resolves.toEqual({ ok: false })
  })

  it('recovers JSON surrounded by prose with no fence', async () => {
    const client = clientReturning('Here is the result: {"ok":true} — done.')
    const provider = new OllamaLlmProvider({ client, model: 'm' })

    await expect(provider.json('p', 'Thing', parseThing)).resolves.toEqual({ ok: true })
  })

  it('retries when the response does not parse, then succeeds', async () => {
    const client = clientReturning('not json at all', '{"ok":true}')
    const provider = new OllamaLlmProvider({ client, model: 'm' })

    await expect(provider.json('p', 'Thing', parseThing)).resolves.toEqual({ ok: true })
    expect(client.calls).toHaveLength(2)
  })

  it('retries when the caller-supplied parse rejects the shape', async () => {
    const client = clientReturning('{"wrong":1}', '{"ok":true}')
    const provider = new OllamaLlmProvider({ client, model: 'm' })

    await expect(provider.json('p', 'Thing', parseThing)).resolves.toEqual({ ok: true })
    expect(client.calls).toHaveLength(2)
  })

  it('gives up after the configured attempts and names the schema and the raw response', async () => {
    const client = clientReturning('still not json')
    const provider = new OllamaLlmProvider({ client, model: 'm', jsonAttempts: 2 })

    await expect(provider.json('p', 'Thing', parseThing)).rejects.toThrow(/Thing/)
    await expect(provider.json('p', 'Thing', parseThing)).rejects.toThrow(/still not json/)
    expect(client.calls).toHaveLength(4) // 2 attempts per call, 2 calls
  })

  it('logs each failed attempt so a bad prompt is diagnosable', async () => {
    const log = vi.fn<(message: string) => void>()
    const client = clientReturning('nope', '{"ok":true}')
    const provider = new OllamaLlmProvider({ client, model: 'm', log })

    await provider.json('p', 'Thing', parseThing)

    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]![0]).toMatch(/Thing/)
  })
})

describe('OllamaLlmProvider.unload', () => {
  it('delegates to the client for the configured model', async () => {
    const unload = vi.fn<(model: string) => Promise<void>>(async () => {})
    const provider = new OllamaLlmProvider({
      client: { generate: async () => '', unload },
      model: 'test-model',
    })

    await provider.unload()

    expect(unload).toHaveBeenCalledWith('test-model')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/providers/src/ollama`
Expected: FAIL — `OllamaLlmProvider` is not exported.

- [ ] **Step 3: Write the client**

Create `packages/providers/src/ollama/client.ts`:

```ts
export interface OllamaGenerateRequest {
  model: string
  prompt: string
  /** Ask the server to constrain output to JSON. */
  json: boolean
  temperature?: number
  maxTokens?: number
}

export interface OllamaClient {
  generate(req: OllamaGenerateRequest): Promise<string>
  /** Releases the model's memory. Called by the ModelBroker via the provider, never by a stage. */
  unload(model: string): Promise<void>
}

interface OllamaGenerateResponse {
  response?: string
}

/**
 * Talks to a locally-running Ollama over HTTP. It never starts a server: the server's
 * lifetime is the operator's business (`pnpm ollama:serve`), and silently spawning one from
 * inside the pipeline would leave an orphaned process holding gigabytes of memory.
 */
export const createHttpOllamaClient = (opts: {
  host: string
  fetchImpl?: typeof fetch
}): OllamaClient => {
  const doFetch = opts.fetchImpl ?? fetch
  const base = opts.host.replace(/\/+$/, '')

  const post = async (path: string, body: unknown): Promise<Response> => {
    try {
      return await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(
        `cannot reach the model server at ${base} (${detail}). Start one with: pnpm ollama:serve`,
      )
    }
  }

  return {
    async generate(req) {
      const res = await post('/api/generate', {
        model: req.model,
        prompt: req.prompt,
        stream: false,
        ...(req.json ? { format: 'json' } : {}),
        options: {
          ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
          ...(req.maxTokens === undefined ? {} : { num_predict: req.maxTokens }),
        },
      })
      if (!res.ok) {
        throw new Error(`model server returned ${res.status} ${res.statusText} for /api/generate`)
      }
      const body = (await res.json()) as OllamaGenerateResponse
      return body.response ?? ''
    },

    async unload(model) {
      // keep_alive: 0 is how Ollama is told to drop the model from memory immediately.
      const res = await post('/api/generate', { model, prompt: '', keep_alive: 0 })
      if (!res.ok) {
        throw new Error(`model server returned ${res.status} unloading '${model}'`)
      }
    },
  }
}
```

- [ ] **Step 4: Write the provider**

Create `packages/providers/src/ollama/llm-provider.ts`:

```ts
import type { LlmProvider } from '@yt/core'
import type { OllamaClient } from './client'

/**
 * Local models frequently wrap JSON in prose or a fenced block even when told not to, so
 * pull the outermost JSON value out of whatever came back before parsing.
 */
export const extractJson = (raw: string): string => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const text = (fenced?.[1] ?? raw).trim()

  const firstObj = text.indexOf('{')
  const firstArr = text.indexOf('[')
  const start =
    firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr)
  if (start === -1) return text

  const closer = text[start] === '{' ? '}' : ']'
  const end = text.lastIndexOf(closer)
  return end > start ? text.slice(start, end + 1) : text.slice(start)
}

export class OllamaLlmProvider implements LlmProvider {
  private readonly attempts: number

  constructor(
    private readonly deps: {
      client: OllamaClient
      model: string
      /** How many times to re-ask when the response will not parse. */
      jsonAttempts?: number
      log?: (message: string) => void
    },
  ) {
    this.attempts = deps.jsonAttempts ?? 3
  }

  async complete(prompt: string, opts?: { temperature?: number; maxTokens?: number }): Promise<string> {
    return this.deps.client.generate({
      model: this.deps.model,
      prompt,
      json: false,
      ...(opts?.temperature === undefined ? {} : { temperature: opts.temperature }),
      ...(opts?.maxTokens === undefined ? {} : { maxTokens: opts.maxTokens }),
    })
  }

  /**
   * The interface's contract is that stages never see malformed JSON, so the retry loop
   * lives here rather than in every stage. A caller-supplied `parse` that throws counts as
   * a failed attempt: a syntactically valid but wrongly-shaped response is just as unusable.
   */
  async json<T>(prompt: string, schemaName: string, parse: (raw: unknown) => T): Promise<T> {
    let lastRaw = ''
    let lastError = 'unknown error'

    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      lastRaw = await this.deps.client.generate({
        model: this.deps.model,
        prompt,
        json: true,
      })

      try {
        return parse(JSON.parse(extractJson(lastRaw)))
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        this.deps.log?.(
          `${schemaName}: attempt ${attempt}/${this.attempts} produced unusable output (${lastError})`,
        )
      }
    }

    const excerpt = lastRaw.length > 500 ? `${lastRaw.slice(0, 500)}…` : lastRaw
    throw new Error(
      `model did not produce valid ${schemaName} after ${this.attempts} attempts ` +
        `(last error: ${lastError}). Last response was: ${excerpt}`,
    )
  }

  /** Called by the ModelBroker only. */
  async unload(): Promise<void> {
    await this.deps.client.unload(this.deps.model)
  }
}
```

Append to `packages/providers/src/index.ts`:

```ts
export * from './ollama/client'
export * from './ollama/llm-provider'
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test`
Expected: PASS — 9 new provider tests, everything else unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/providers/src
git commit -m "feat(providers): add ollama LLM provider with JSON recovery and retry"
```

---

### Task 6: The topic artifact

`TopicScout` selects a topic and every later stage needs it, but `ArtifactName` has no `'topic'` member and there is no schema for it.

**Files:**
- Modify: `packages/core/src/stage.ts` (widen `ArtifactName`)
- Modify: `packages/core/src/schemas/content.ts`
- Modify: `packages/core/src/schemas/content.test.ts`

**Interfaces:**
- Consumes: `TREND_SOURCES` from `@yt/core`
- Produces: `ArtifactName` gains `'topic'`; `TopicSchema` / `Topic`; `ScoredCandidateSchema` / `ScoredCandidate`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/schemas/content.test.ts`:

```ts
describe('TopicSchema', () => {
  const topic = (overrides: Record<string, unknown> = {}) => ({
    key: 'venus-retrograde-rotation',
    title: 'Why Venus rotates backwards',
    source: 'wikipedia-top',
    url: 'https://en.wikipedia.org/wiki/Venus',
    angle: 'Follow the single measurement that overturned the assumption.',
    scores: { curiosity: 8, explainability: 7, visualPotential: 6, evergreen: 9 },
    total: 30,
    ...overrides,
  })

  it('accepts a well-formed selected topic', () => {
    expect(TopicSchema.safeParse(topic()).success).toBe(true)
  })

  it('allows a null url, since not every trend source has one', () => {
    expect(TopicSchema.safeParse(topic({ url: null })).success).toBe(true)
  })

  it('rejects a source that is not a known trend source', () => {
    expect(TopicSchema.safeParse(topic({ source: 'tiktok' })).success).toBe(false)
  })

  it('rejects a score outside 0-10', () => {
    const bad = topic({ scores: { curiosity: 11, explainability: 7, visualPotential: 6, evergreen: 9 } })
    expect(TopicSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects an empty key, because the key is the permanent dedupe identity', () => {
    expect(TopicSchema.safeParse(topic({ key: '' })).success).toBe(false)
  })
})
```

Add `TopicSchema` to the `@yt/core` import in that file.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/core/src/schemas/content.test.ts`
Expected: FAIL — `TopicSchema` is undefined.

- [ ] **Step 3: Add the schemas**

Append to `packages/core/src/schemas/content.ts`:

```ts
export const TopicScoresSchema = z.object({
  curiosity: z.number().min(0).max(10),
  explainability: z.number().min(0).max(10),
  visualPotential: z.number().min(0).max(10),
  evergreen: z.number().min(0).max(10),
})

/** A candidate after the model has scored it, before one is chosen. */
export const ScoredCandidateSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  scores: TopicScoresSchema,
  total: z.number().min(0).max(40),
})
export type ScoredCandidate = z.infer<typeof ScoredCandidateSchema>

/** The chosen topic for a run. `key` is the permanent dedupe identity. */
export const TopicSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  source: z.enum(TREND_SOURCES),
  url: z.string().url().nullable(),
  /** The specific angle the script should take, so the writer is not left to invent one. */
  angle: z.string().min(1),
  scores: TopicScoresSchema,
  total: z.number().min(0).max(40),
})
export type Topic = z.infer<typeof TopicSchema>
```

Add `TREND_SOURCES` to the imports at the top of `content.ts`:

```ts
import { TREND_SOURCES } from './config'
```

**Watch for a circular import:** `config.ts` imports `SECTION_KINDS` and `VIDEO_FORMATS` from `../domain`, and `content.ts` imports from `../domain` too — importing `TREND_SOURCES` from `./config` into `content.ts` is a new edge. If it creates a cycle at runtime, move `TREND_SOURCES` and `TrendSource` into `domain.ts` (where the other shared vocabulary lives), re-export them from `config.ts` for compatibility, and import from `../domain` in both files. Report which route you took.

- [ ] **Step 4: Widen `ArtifactName`**

In `packages/core/src/stage.ts`:

```ts
export type ArtifactName = 'topic' | 'research' | 'script' | 'factcheck' | 'scenes' | 'seo' | 'videoSpec'
```

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: PASS — 5 new schema tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src
git commit -m "feat(core): add the topic artifact schema and artifact name"
```

---

### Task 7: The keyless trend provider

Real candidate topics from public sources that need no API key and no account, per spec §4 stage 1.

**Files:**
- Create: `packages/providers/src/trends/sources.ts`
- Create: `packages/providers/src/trends/trend-provider.ts`
- Create: `packages/providers/src/trends/trend-provider.test.ts`
- Modify: `packages/providers/src/index.ts`

**Interfaces:**
- Consumes: `TrendProvider`, `TopicCandidate`, `TrendSource`, `TREND_SOURCES` from `@yt/core`
- Produces:
  - `type SourceFetcher = (fetchImpl: typeof fetch) => Promise<TopicCandidate[]>`
  - `SOURCE_FETCHERS: Record<TrendSource, SourceFetcher>`
  - `class HttpTrendProvider implements TrendProvider` — `constructor(deps: { fetchImpl?: typeof fetch; fetchers?: Partial<Record<TrendSource, SourceFetcher>>; log?: (message: string) => void })`
  - `slugifyKey(title: string): string`

**Design notes:**
- One source failing must not fail the whole fetch. Log it and carry on with the others; a run should not die because Reddit was briefly unavailable.
- Every candidate needs a stable `key` for permanent dedupe. Derive it from the title via `slugifyKey` unless the source supplies a natural id.
- Endpoints, all keyless: Wikipedia most-viewed `https://en.wikipedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/<yyyy>/<mm>/<dd>`; Hacker News `https://hn.algolia.com/api/v1/search?tags=front_page`; arXiv `http://export.arxiv.org/api/query?search_query=cat:cs.AI&sortBy=submittedDate&sortOrder=descending&max_results=20`; Reddit `https://www.reddit.com/r/todayilearned/top.json?t=week&limit=20`; Google Trends `https://trends.google.com/trends/trendingsearches/daily/rss?geo=US`.
- arXiv and Google Trends return XML/RSS. Do not add an XML parser dependency — extract `<title>` contents with a regex and strip CDATA. It is a title list, not a document tree.
- Reddit requires a non-default `User-Agent` or it returns 429. Send one.

- [ ] **Step 1: Write the failing test**

Create `packages/providers/src/trends/trend-provider.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { HttpTrendProvider, slugifyKey, type SourceFetcher } from '@yt/providers'
import type { TopicCandidate } from '@yt/core'

const candidate = (title: string, source: TopicCandidate['source']): TopicCandidate => ({
  key: slugifyKey(title),
  title,
  source,
  url: null,
})

describe('slugifyKey', () => {
  it('produces a stable lowercase slug', () => {
    expect(slugifyKey('Why Venus Rotates Backwards')).toBe('why-venus-rotates-backwards')
  })

  it('strips punctuation and collapses separators', () => {
    expect(slugifyKey('  The "Great" Attractor: what is it?! ')).toBe('the-great-attractor-what-is-it')
  })

  it('is identical for titles differing only in case or spacing', () => {
    expect(slugifyKey('Deep  Sea   Vents')).toBe(slugifyKey('deep sea vents'))
  })
})

describe('HttpTrendProvider', () => {
  it('returns candidates only from the requested sources', async () => {
    const fetchers: Partial<Record<TopicCandidate['source'], SourceFetcher>> = {
      hackernews: async () => [candidate('An HN story', 'hackernews')],
      arxiv: async () => [candidate('A paper', 'arxiv')],
    }
    const provider = new HttpTrendProvider({ fetchers })

    const got = await provider.fetchCandidates(['hackernews'])

    expect(got.map((c) => c.title)).toEqual(['An HN story'])
  })

  it('merges candidates across several sources', async () => {
    const fetchers: Partial<Record<TopicCandidate['source'], SourceFetcher>> = {
      hackernews: async () => [candidate('An HN story', 'hackernews')],
      arxiv: async () => [candidate('A paper', 'arxiv')],
    }
    const provider = new HttpTrendProvider({ fetchers })

    const got = await provider.fetchCandidates(['hackernews', 'arxiv'])

    expect(got).toHaveLength(2)
  })

  it('survives one source failing and still returns the others', async () => {
    const log = vi.fn<(message: string) => void>()
    const fetchers: Partial<Record<TopicCandidate['source'], SourceFetcher>> = {
      hackernews: async () => {
        throw new Error('network down')
      },
      arxiv: async () => [candidate('A paper', 'arxiv')],
    }
    const provider = new HttpTrendProvider({ fetchers, log })

    const got = await provider.fetchCandidates(['hackernews', 'arxiv'])

    expect(got.map((c) => c.title)).toEqual(['A paper'])
    expect(log.mock.calls[0]![0]).toMatch(/hackernews/)
  })

  it('deduplicates candidates that different sources both surfaced', async () => {
    const fetchers: Partial<Record<TopicCandidate['source'], SourceFetcher>> = {
      hackernews: async () => [candidate('Deep sea vents', 'hackernews')],
      reddit: async () => [candidate('deep  sea  vents', 'reddit')],
    }
    const provider = new HttpTrendProvider({ fetchers })

    const got = await provider.fetchCandidates(['hackernews', 'reddit'])

    expect(got).toHaveLength(1)
  })

  it('returns an empty array when no source yields anything, rather than throwing', async () => {
    const provider = new HttpTrendProvider({ fetchers: { arxiv: async () => [] } })
    await expect(provider.fetchCandidates(['arxiv'])).resolves.toEqual([])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/providers/src/trends`
Expected: FAIL — `HttpTrendProvider` is not exported.

- [ ] **Step 3: Write the source fetchers**

Create `packages/providers/src/trends/sources.ts`:

```ts
import type { TopicCandidate, TrendSource } from '@yt/core'

/** Stable dedupe identity for a candidate. Case- and punctuation-insensitive. */
export const slugifyKey = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

export type SourceFetcher = (fetchImpl: typeof fetch) => Promise<TopicCandidate[]>

const USER_AGENT = 'ai-youtube-factory/0.1 (local, personal use)'

const getJson = async (fetchImpl: typeof fetch, url: string): Promise<unknown> => {
  const res = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' } })
  if (!res.ok) throw new Error(`${url} returned ${res.status}`)
  return res.json()
}

const getText = async (fetchImpl: typeof fetch, url: string): Promise<string> => {
  const res = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT } })
  if (!res.ok) throw new Error(`${url} returned ${res.status}`)
  return res.text()
}

/** Pull <title> contents out of an RSS/Atom feed without adding an XML parser. */
const titlesFromFeed = (xml: string): string[] =>
  [...xml.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi)]
    .map((m) => (m[1] ?? '').replace(/<!\[CDATA\[|\]\]>/g, '').trim())
    .filter((t) => t.length > 0)

/** Yesterday in UTC — today's pageview data is not published yet. */
const yesterdayParts = (): { y: string; m: string; d: string } => {
  const t = new Date(Date.now() - 24 * 60 * 60 * 1000)
  return {
    y: String(t.getUTCFullYear()),
    m: String(t.getUTCMonth() + 1).padStart(2, '0'),
    d: String(t.getUTCDate()).padStart(2, '0'),
  }
}

const wikipediaTop: SourceFetcher = async (fetchImpl) => {
  const { y, m, d } = yesterdayParts()
  const body = (await getJson(
    fetchImpl,
    `https://en.wikipedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${y}/${m}/${d}`,
  )) as { items?: { articles?: { article?: string }[] }[] }

  const articles = body.items?.[0]?.articles ?? []
  return articles
    .map((a) => a.article ?? '')
    // Portal pages, the front page and search are not video subjects.
    .filter((a) => a && !a.includes(':') && a !== 'Main_Page')
    .slice(0, 25)
    .map((a) => {
      const title = a.replace(/_/g, ' ')
      return {
        key: slugifyKey(title),
        title,
        source: 'wikipedia-top' as const,
        url: `https://en.wikipedia.org/wiki/${a}`,
      }
    })
}

const hackernews: SourceFetcher = async (fetchImpl) => {
  const body = (await getJson(fetchImpl, 'https://hn.algolia.com/api/v1/search?tags=front_page')) as {
    hits?: { title?: string; url?: string | null; objectID?: string }[]
  }
  return (body.hits ?? [])
    .filter((h) => h.title)
    .slice(0, 25)
    .map((h) => ({
      key: h.objectID ? `hn-${h.objectID}` : slugifyKey(h.title!),
      title: h.title!,
      source: 'hackernews' as const,
      url: h.url ?? null,
    }))
}

const arxiv: SourceFetcher = async (fetchImpl) => {
  const xml = await getText(
    fetchImpl,
    'http://export.arxiv.org/api/query?search_query=cat:cs.AI&sortBy=submittedDate&sortOrder=descending&max_results=20',
  )
  // The first <title> is the feed's own title, not an entry.
  return titlesFromFeed(xml)
    .slice(1)
    .map((title) => ({ key: slugifyKey(title), title, source: 'arxiv' as const, url: null }))
}

const reddit: SourceFetcher = async (fetchImpl) => {
  const body = (await getJson(
    fetchImpl,
    'https://www.reddit.com/r/todayilearned/top.json?t=week&limit=20',
  )) as { data?: { children?: { data?: { title?: string; permalink?: string; id?: string } }[] } }

  return (body.data?.children ?? [])
    .map((c) => c.data)
    .filter((d): d is { title: string; permalink?: string; id?: string } => Boolean(d?.title))
    .map((d) => ({
      key: d.id ? `reddit-${d.id}` : slugifyKey(d.title),
      // TIL posts are phrased as "TIL that ..."; strip the prefix so the title reads cleanly.
      title: d.title.replace(/^TIL\s+(that\s+)?/i, ''),
      source: 'reddit' as const,
      url: d.permalink ? `https://www.reddit.com${d.permalink}` : null,
    }))
}

const googleTrends: SourceFetcher = async (fetchImpl) => {
  const xml = await getText(
    fetchImpl,
    'https://trends.google.com/trends/trendingsearches/daily/rss?geo=US',
  )
  return titlesFromFeed(xml)
    .slice(1)
    .map((title) => ({ key: slugifyKey(title), title, source: 'google-trends' as const, url: null }))
}

export const SOURCE_FETCHERS: Record<TrendSource, SourceFetcher> = {
  'wikipedia-top': wikipediaTop,
  hackernews,
  arxiv,
  reddit,
  'google-trends': googleTrends,
}
```

- [ ] **Step 4: Write the provider**

Create `packages/providers/src/trends/trend-provider.ts`:

```ts
import type { TopicCandidate, TrendProvider, TrendSource } from '@yt/core'
import { SOURCE_FETCHERS, type SourceFetcher } from './sources'

export class HttpTrendProvider implements TrendProvider {
  private readonly fetchImpl: typeof fetch
  private readonly fetchers: Record<TrendSource, SourceFetcher>

  constructor(deps: {
    fetchImpl?: typeof fetch
    fetchers?: Partial<Record<TrendSource, SourceFetcher>>
    log?: (message: string) => void
  } = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.fetchers = { ...SOURCE_FETCHERS, ...deps.fetchers }
    this.log = deps.log
  }

  private readonly log?: (message: string) => void

  /**
   * One source failing must not fail the fetch — a run should not die because a public
   * endpoint was briefly unavailable. Failures are logged and the rest are returned.
   */
  async fetchCandidates(sources: readonly TrendSource[]): Promise<TopicCandidate[]> {
    const results = await Promise.all(
      sources.map(async (source) => {
        try {
          return await this.fetchers[source](this.fetchImpl)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          this.log?.(`trend source '${source}' failed and was skipped: ${detail}`)
          return []
        }
      }),
    )

    // Two sources often surface the same subject; the first one wins.
    const byKey = new Map<string, TopicCandidate>()
    for (const candidate of results.flat()) {
      if (!byKey.has(candidate.key)) byKey.set(candidate.key, candidate)
    }
    return [...byKey.values()]
  }
}
```

Append to `packages/providers/src/index.ts`:

```ts
export * from './trends/sources'
export * from './trends/trend-provider'
```

**Note:** the dedupe test expects `'Deep sea vents'` from Hacker News and `'deep  sea  vents'` from Reddit to collapse. The HN fetcher keys off `objectID` when present, so in that test the fixture fetchers supply `slugifyKey`-derived keys directly — which is what makes them collide. Keep the production keying as written; a natural id is more stable than a slug when the source provides one.

- [ ] **Step 5: Run the tests**

Run: `pnpm test`
Expected: PASS — 9 new trend tests.

- [ ] **Step 6: Verify the real endpoints once, by hand**

Run a scratch script (delete it afterwards) that calls each of the five fetchers against the live endpoints and prints how many candidates each returned plus the first title. Record the output in your report. This is the only place the plan asks you to touch the live internet in a unit-test task, and it matters: these are undocumented public endpoints whose shapes drift, and finding out now is far cheaper than a failing stage later. If a source returns zero candidates or errors, report which and why — do not silently adjust the parser to make it look successful.

- [ ] **Step 7: Commit**

```bash
git add packages/providers/src
git commit -m "feat(providers): add keyless trend sources and a fault-tolerant trend provider"
```

---

## Stage conventions (Tasks 8–13)

Every stage below follows the same shape, so read this once rather than six times.

- Each file exports a **factory**, not an instance: `export const createXStage = (): Stage => ({ name, requires, async run(ctx) {...} })`. A factory keeps stages free of module-level state and lets a test build a fresh one.
- `name` and `requires` come from the canonical map: `requires: STAGE_REQUIREMENTS['<name>']`. Never hardcode the value — Task 3's validation rejects a disagreement.
- Prompts live in `packages/pipeline/src/stages/prompts/<stage>.ts` as pure functions returning a string. Keeping them out of the stage means a prompt can be tuned without touching orchestration, and a prompt can be unit-tested for the facts it embeds.
- A stage reads its inputs with `ctx.artifacts.read(name, Schema)` and writes with `ctx.artifacts.write(name, Schema, value)`. The store validates both directions, so a stage may trust what it reads.
- A stage returns `{ status: 'halted', reason }` for a condition a retry cannot fix (no unused topics left, too many unsupported claims). It **throws** for a transient failure it wants retried. Getting this backwards either burns three attempts on a hopeless run or gives up on a blip.
- Every prompt that must produce JSON goes through `ctx.providers.llm.json(prompt, '<SchemaName>', parse)` where `parse` is the Zod schema's `parse`. The provider owns the retry loop; a stage never sees malformed JSON.
- Log one line at the start and one on completion via `ctx.log.info`, including the decision made (which topic, how many claims checked). These lines are what the dashboard shows in Plan 4.

---

### Task 8: TopicScout

Picks a subject that has never been used before. Spec §4 stage 1.

**Files:**
- Create: `packages/pipeline/src/stages/prompts/topic-scout.ts`
- Create: `packages/pipeline/src/stages/topic-scout.ts`
- Create: `packages/pipeline/src/stages/topic-scout.test.ts`

**Interfaces:**
- Consumes: `Stage`, `RunContext`, `STAGE_REQUIREMENTS`, `TopicSchema`, `ScoredCandidateSchema`, `TopicCandidate` (Tasks 1, 6)
- Produces: `buildTopicScoutPrompt(input: { candidates: TopicCandidate[]; nicheLabel: string; promptGuidance: string }): string`; `createTopicScoutStage(): Stage`; the `topic` artifact.

- [ ] **Step 1: Write the failing test**

Create `packages/pipeline/src/stages/topic-scout.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TopicSchema, type RunContext, type TopicCandidate } from '@yt/core'
import { createTopicScoutStage, buildTopicScoutPrompt } from '@yt/pipeline'
import { makeStageContext, type StageHarness } from '../../../../test/fixtures/stage-context'

let h: StageHarness

beforeEach(async () => {
  h = await makeStageContext()
})
afterEach(async () => {
  await h.cleanup()
})

const candidates = (...titles: string[]): TopicCandidate[] =>
  titles.map((title, i) => ({
    key: `key-${i}`,
    title,
    source: 'wikipedia-top' as const,
    url: `https://example.invalid/${i}`,
  }))

describe('buildTopicScoutPrompt', () => {
  it('embeds every candidate title and the niche guidance', () => {
    const prompt = buildTopicScoutPrompt({
      candidates: candidates('Venus rotation', 'Deep sea vents'),
      nicheLabel: 'Space',
      promptGuidance: 'Explain one cosmic phenomenon.',
    })

    expect(prompt).toContain('Venus rotation')
    expect(prompt).toContain('Deep sea vents')
    expect(prompt).toContain('Explain one cosmic phenomenon.')
    expect(prompt).toContain('Space')
  })

  it('asks for all four scoring dimensions by name', () => {
    const prompt = buildTopicScoutPrompt({ candidates: candidates('X'), nicheLabel: 'Space', promptGuidance: 'g' })
    for (const dim of ['curiosity', 'explainability', 'visualPotential', 'evergreen']) {
      expect(prompt).toContain(dim)
    }
  })
})

describe('createTopicScoutStage', () => {
  it('writes the highest-scoring candidate as the topic artifact', async () => {
    h.providers.trend.fetchCandidates = async () => candidates('Low pick', 'High pick')
    h.providers.llm.json = (async () => ({
      candidates: [
        { key: 'key-0', title: 'Low pick', scores: { curiosity: 2, explainability: 2, visualPotential: 2, evergreen: 2 }, total: 8 },
        { key: 'key-1', title: 'High pick', scores: { curiosity: 9, explainability: 8, visualPotential: 8, evergreen: 9 }, total: 34 },
      ],
      chosenKey: 'key-1',
      angle: 'Follow the measurement that overturned the assumption.',
    })) as RunContext['providers']['llm']['json']

    await expect(createTopicScoutStage().run(h.ctx)).resolves.toEqual({ status: 'done' })

    const topic = await h.ctx.artifacts.read('topic', TopicSchema)
    expect(topic.title).toBe('High pick')
    expect(topic.total).toBe(34)
    expect(topic.angle).toMatch(/measurement/)
  })

  it('records the chosen topic as used so it can never be picked again', async () => {
    h.providers.trend.fetchCandidates = async () => candidates('Only option')
    h.providers.llm.json = (async () => ({
      candidates: [{ key: 'key-0', title: 'Only option', scores: { curiosity: 5, explainability: 5, visualPotential: 5, evergreen: 5 }, total: 20 }],
      chosenKey: 'key-0',
      angle: 'An angle.',
    })) as RunContext['providers']['llm']['json']

    await createTopicScoutStage().run(h.ctx)

    expect(await h.repos.topics.hasUsed('key-0')).toBe(true)
  })

  it('never offers the model a topic that was already used', async () => {
    await h.repos.topics.markUsed('key-0', 'Already done')
    h.providers.trend.fetchCandidates = async () => candidates('Already done', 'Fresh one')
    const seen: string[] = []
    h.providers.llm.json = (async (prompt: string) => {
      seen.push(prompt)
      return {
        candidates: [{ key: 'key-1', title: 'Fresh one', scores: { curiosity: 5, explainability: 5, visualPotential: 5, evergreen: 5 }, total: 20 }],
        chosenKey: 'key-1',
        angle: 'An angle.',
      }
    }) as RunContext['providers']['llm']['json']

    await createTopicScoutStage().run(h.ctx)

    expect(seen[0]).not.toContain('Already done')
    expect(seen[0]).toContain('Fresh one')
  })

  it('halts, rather than throwing, when every candidate has been used', async () => {
    await h.repos.topics.markUsed('key-0', 'Used')
    h.providers.trend.fetchCandidates = async () => candidates('Used')

    const outcome = await createTopicScoutStage().run(h.ctx)

    expect(outcome).toMatchObject({ status: 'halted' })
    expect((outcome as { reason: string }).reason).toMatch(/already been used|no unused/i)
  })

  it('halts when no source returned any candidate at all', async () => {
    h.providers.trend.fetchCandidates = async () => []

    const outcome = await createTopicScoutStage().run(h.ctx)

    expect(outcome).toMatchObject({ status: 'halted' })
  })

  it('falls back to the highest total when the model chooses a key it was not offered', async () => {
    h.providers.trend.fetchCandidates = async () => candidates('A', 'B')
    h.providers.llm.json = (async () => ({
      candidates: [
        { key: 'key-0', title: 'A', scores: { curiosity: 3, explainability: 3, visualPotential: 3, evergreen: 3 }, total: 12 },
        { key: 'key-1', title: 'B', scores: { curiosity: 9, explainability: 9, visualPotential: 9, evergreen: 9 }, total: 36 },
      ],
      chosenKey: 'a-key-that-does-not-exist',
      angle: 'An angle.',
    })) as RunContext['providers']['llm']['json']

    await createTopicScoutStage().run(h.ctx)

    const topic = await h.ctx.artifacts.read('topic', TopicSchema)
    expect(topic.key).toBe('key-1')
  })

  it('requests only the trend sources the niche config names', async () => {
    const asked: unknown[] = []
    h.providers.trend.fetchCandidates = async (sources) => {
      asked.push([...sources])
      return candidates('X')
    }
    h.providers.llm.json = (async () => ({
      candidates: [{ key: 'key-0', title: 'X', scores: { curiosity: 5, explainability: 5, visualPotential: 5, evergreen: 5 }, total: 20 }],
      chosenKey: 'key-0',
      angle: 'An angle.',
    })) as RunContext['providers']['llm']['json']

    await createTopicScoutStage().run(h.ctx)

    expect(asked[0]).toEqual(h.ctx.config.nicheConfig.trendSources)
  })
})
```

- [ ] **Step 2: Write the shared stage-test harness**

The six stage test files all need a real `RunContext` wired to a temp storage directory, a test database and mutable fake providers. Create `test/fixtures/stage-context.ts`:

```ts
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_APP_CONFIG, FORMAT_PRESETS, type ProviderBundle, type RunContext } from '@yt/core'
import { createFakeProviders, FixedClock } from '@yt/providers'
import type { Repositories } from '@yt/db'
import { EventRunLogger, FileArtifactStore, ensureRunDirs, runPaths, type LogEntry } from '@yt/pipeline'
import { createTestDb } from '../setup/db'

export interface StageHarness {
  ctx: RunContext
  /** The same provider objects the context holds, so a test can overwrite a method. */
  providers: ProviderBundle
  repos: Repositories
  logs: LogEntry[]
  cleanup: () => Promise<void>
}

const NICHE = {
  id: 'space',
  label: 'Space',
  promptGuidance: 'Explain one cosmic phenomenon through a single concrete object.',
  voice: 'male',
  styleSuffix: 'cinematic astrophotography',
  music: 'ambient-drone',
  trendSources: ['wikipedia-top', 'arxiv'],
  seoRules: 'Lead with the object, not the concept.',
  monetizationRisk: 'low',
} as const

export const makeStageContext = async (
  overrides: { videoType?: 'shorts' | 'long'; runId?: string } = {},
): Promise<StageHarness> => {
  const db = await createTestDb()
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-stage-'))
  const runId = overrides.runId ?? 'run-stage-test'
  const videoType = overrides.videoType ?? 'long'

  await db.repos.runs.create({
    id: runId,
    niche: 'space',
    format: videoType,
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
  })

  const paths = runPaths(storageRoot, runId)
  await ensureRunDirs(paths)

  const providers = createFakeProviders()
  const logs: LogEntry[] = []

  const ctx: RunContext = {
    runId,
    config: {
      ...DEFAULT_APP_CONFIG,
      videoType,
      nicheConfig: { ...NICHE, trendSources: [...NICHE.trendSources] },
      preset: FORMAT_PRESETS[videoType],
    },
    paths,
    artifacts: new FileArtifactStore(paths),
    topics: db.repos.topics,
    clipRequests: db.repos.clips,
    providers,
    log: new EventRunLogger(runId, (entry) => logs.push(entry)),
    clock: new FixedClock('2026-08-01T10:00:00.000Z'),
  }

  return {
    ctx,
    providers,
    repos: db.repos,
    logs,
    cleanup: async () => {
      await db.cleanup()
      await fs.rm(storageRoot, { recursive: true, force: true })
    },
  }
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run packages/pipeline/src/stages/topic-scout.test.ts`
Expected: FAIL — `createTopicScoutStage` is not exported.

- [ ] **Step 4: Write the prompt**

Create `packages/pipeline/src/stages/prompts/topic-scout.ts`:

```ts
import type { TopicCandidate } from '@yt/core'

/**
 * Scores candidates and picks one. The four dimensions come from spec section 4 stage 1.
 * The angle is requested here rather than left to the script writer, so the run commits to
 * a specific take before any research happens.
 */
export const buildTopicScoutPrompt = (input: {
  candidates: TopicCandidate[]
  nicheLabel: string
  promptGuidance: string
}): string => {
  const list = input.candidates
    .map((c, i) => `${i + 1}. [key: ${c.key}] ${c.title}`)
    .join('\n')

  return `You are selecting the subject of one YouTube video for a channel about ${input.nicheLabel}.

Channel guidance: ${input.promptGuidance}

Score each candidate below from 0 to 10 on four dimensions:
- curiosity: how strongly the subject makes a viewer want the answer
- explainability: how well it can be explained in a few minutes without visuals of the real thing
- visualPotential: how much there is to show, illustrate, map or chart
- evergreen: how likely someone still searches for this in two years

Then choose the single best candidate and state the specific angle the video should take. The
angle must be one concrete sentence naming what the video follows — an object, a measurement,
a decision, a conflict — not a restatement of the title and not a generic promise.

Candidates:
${list}

Respond with JSON only, in exactly this shape:
{
  "candidates": [
    { "key": "<the key given above>", "title": "<title>", "scores": { "curiosity": 0, "explainability": 0, "visualPotential": 0, "evergreen": 0 }, "total": 0 }
  ],
  "chosenKey": "<key of the best candidate>",
  "angle": "<one concrete sentence>"
}

"total" must be the sum of the four scores. Include every candidate. Use only keys from the list.`
}
```

- [ ] **Step 5: Write the stage**

Create `packages/pipeline/src/stages/topic-scout.ts`:

```ts
import { z } from 'zod'
import {
  ScoredCandidateSchema,
  STAGE_REQUIREMENTS,
  TopicSchema,
  type Stage,
  type Topic,
} from '@yt/core'
import { buildTopicScoutPrompt } from './prompts/topic-scout'

const SelectionSchema = z.object({
  candidates: z.array(ScoredCandidateSchema).min(1),
  chosenKey: z.string().min(1),
  angle: z.string().min(1),
})

export const createTopicScoutStage = (): Stage => ({
  name: 'topic-scout',
  requires: STAGE_REQUIREMENTS['topic-scout'],

  async run(ctx) {
    const sources = ctx.config.nicheConfig.trendSources
    ctx.log.info(`fetching topic candidates from ${sources.join(', ')}`)

    const all = await ctx.providers.trend.fetchCandidates(sources)
    if (all.length === 0) {
      return {
        status: 'halted',
        reason: `no trend source returned any candidate (tried ${sources.join(', ')})`,
      }
    }

    // Permanent dedupe: a subject is never used twice across the channel's life.
    const fresh = []
    for (const candidate of all) {
      if (!(await ctx.topics.hasUsed(candidate.key))) fresh.push(candidate)
    }
    if (fresh.length === 0) {
      return {
        status: 'halted',
        reason: `all ${all.length} candidates have already been used; nothing fresh to make a video about`,
      }
    }

    const selection = await ctx.providers.llm.json(
      buildTopicScoutPrompt({
        candidates: fresh,
        nicheLabel: ctx.config.nicheConfig.label,
        promptGuidance: ctx.config.nicheConfig.promptGuidance,
      }),
      'TopicSelection',
      (raw) => SelectionSchema.parse(raw),
    )

    // Trust the scores over the stated choice: a local model sometimes names a key it was
    // not offered, and the highest total is a defensible answer either way.
    const offered = new Map(fresh.map((c) => [c.key, c]))
    const scored = selection.candidates.filter((c) => offered.has(c.key))
    if (scored.length === 0) {
      return {
        status: 'halted',
        reason: `the model scored none of the ${fresh.length} candidates it was given`,
      }
    }

    const best =
      scored.find((c) => c.key === selection.chosenKey) ??
      [...scored].sort((a, b) => b.total - a.total)[0]!
    const candidate = offered.get(best.key)!

    const topic: Topic = {
      key: candidate.key,
      title: candidate.title,
      source: candidate.source,
      url: candidate.url,
      angle: selection.angle,
      scores: best.scores,
      total: best.total,
    }

    await ctx.artifacts.write('topic', TopicSchema, topic)
    await ctx.topics.markUsed(topic.key, topic.title)

    ctx.log.info(`chose "${topic.title}" (score ${topic.total}/40) from ${fresh.length} fresh candidates`)
    return { status: 'done' }
  },
})
```

- [ ] **Step 6: Export it**

Create `packages/pipeline/src/stages/index.ts`:

```ts
export * from './topic-scout'
export * from './prompts/topic-scout'
```

Append to `packages/pipeline/src/index.ts`:

```ts
export * from './stages'
```

- [ ] **Step 7: Run the tests**

Run: `pnpm test`
Expected: PASS — 10 new tests.

- [ ] **Step 8: Commit**

```bash
git add packages/pipeline/src/stages test/fixtures/stage-context.ts packages/pipeline/src/index.ts
git commit -m "feat(stages): add TopicScout with permanent topic dedupe"
```

---

### Task 9: The research provider

The researcher stage needs grounding facts with source URLs. Per the architecture rule that every external capability sits behind an interface, this is a provider, not raw `fetch` inside a stage.

**Files:**
- Modify: `packages/core/src/providers.ts` (add `ResearchProvider`, `ResearchFact`, and a `research` entry in `ProviderBundle` and `PROVIDER_TOKENS`)
- Modify: `packages/providers/src/fake/index.ts` (fake implementation)
- Create: `packages/providers/src/research/wikipedia.ts`
- Create: `packages/providers/src/research/wikipedia.test.ts`
- Modify: `packages/providers/src/index.ts`

**Interfaces:**
- Produces:
  - `interface ResearchFact { text: string; sourceUrl: string }`
  - `interface ResearchProvider { lookup(query: string, opts?: { maxFacts?: number }): Promise<ResearchFact[]> }`
  - `ProviderBundle` gains `research: ResearchProvider`; `PROVIDER_TOKENS` gains `research: 'RESEARCH_PROVIDER'`
  - `class WikipediaResearchProvider implements ResearchProvider` — `constructor(deps?: { fetchImpl?: typeof fetch; log?: (m: string) => void })`

**Design notes:** the fake must return deterministic facts with valid URLs so `ResearchSchema` accepts them. Splitting a Wikipedia summary into sentence-level facts is what makes the fact checker able to match a claim to a source later. A lookup that finds nothing returns `[]` rather than throwing — the researcher stage decides whether that is fatal.

- [ ] **Step 1: Add the interface to core**

In `packages/core/src/providers.ts`, add:

```ts
export interface ResearchFact {
  text: string
  sourceUrl: string
}

export interface ResearchProvider {
  /** Returns grounding facts with their sources. An empty array means nothing was found. */
  lookup(query: string, opts?: { maxFacts?: number }): Promise<ResearchFact[]>
}
```

Add `research: ResearchProvider` to `ProviderBundle`, and `research: 'RESEARCH_PROVIDER'` to `PROVIDER_TOKENS`.

- [ ] **Step 2: Add it to the fakes**

In `packages/providers/src/fake/index.ts`, add inside `createFakeProviders`:

```ts
  const research: ResearchProvider = {
    async lookup(query, opts) {
      const count = opts?.maxFacts ?? 5
      return Array.from({ length: count }, (_, i) => ({
        text: `Fake fact ${i + 1} about ${query}.`,
        sourceUrl: `https://example.invalid/${encodeURIComponent(query)}#${i + 1}`,
      }))
    },
  }
```

Add `research` to the returned bundle and to the import list. Because `ProviderBundle` gained a member, the fakes will not typecheck until this is done — that is the contract check working.

- [ ] **Step 3: Write the failing Wikipedia test**

Create `packages/providers/src/research/wikipedia.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { WikipediaResearchProvider } from '@yt/providers'

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('WikipediaResearchProvider', () => {
  it('splits a summary into sentence-level facts, each carrying the page URL', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        title: 'Venus',
        extract: 'Venus is the second planet from the Sun. It rotates in the opposite direction to most planets. Its day is longer than its year.',
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Venus' } },
      }),
    ) as unknown as typeof fetch

    const facts = await new WikipediaResearchProvider({ fetchImpl }).lookup('Venus')

    expect(facts).toHaveLength(3)
    expect(facts[0]!.text).toBe('Venus is the second planet from the Sun.')
    expect(facts.every((f) => f.sourceUrl === 'https://en.wikipedia.org/wiki/Venus')).toBe(true)
  })

  it('respects maxFacts', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        title: 'Venus',
        extract: 'One. Two. Three. Four. Five.',
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Venus' } },
      }),
    ) as unknown as typeof fetch

    const facts = await new WikipediaResearchProvider({ fetchImpl }).lookup('Venus', { maxFacts: 2 })

    expect(facts).toHaveLength(2)
  })

  it('returns an empty array when the page does not exist, rather than throwing', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch

    await expect(new WikipediaResearchProvider({ fetchImpl }).lookup('Nonexistent')).resolves.toEqual([])
  })

  it('discards fragments too short to be a usable fact', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        title: 'Venus',
        extract: 'Venus is the second planet from the Sun. Yes. It rotates backwards compared with most planets.',
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Venus' } },
      }),
    ) as unknown as typeof fetch

    const facts = await new WikipediaResearchProvider({ fetchImpl }).lookup('Venus')

    expect(facts.map((f) => f.text)).not.toContain('Yes.')
  })

  it('falls back to a constructed URL when the response omits content_urls', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ title: 'Venus', extract: 'Venus is the second planet from the Sun.' }),
    ) as unknown as typeof fetch

    const facts = await new WikipediaResearchProvider({ fetchImpl }).lookup('Venus')

    expect(facts[0]!.sourceUrl).toMatch(/^https:\/\/en\.wikipedia\.org\/wiki\//)
  })
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm vitest run packages/providers/src/research`
Expected: FAIL — `WikipediaResearchProvider` is not exported.

- [ ] **Step 5: Write the provider**

Create `packages/providers/src/research/wikipedia.ts`:

```ts
import type { ResearchFact, ResearchProvider } from '@yt/core'

const USER_AGENT = 'ai-youtube-factory/0.1 (local, personal use)'

/** Below this length a fragment is an artefact of naive splitting, not a fact. */
const MIN_FACT_CHARS = 25

interface SummaryResponse {
  title?: string
  extract?: string
  content_urls?: { desktop?: { page?: string } }
}

/**
 * Grounding facts from Wikipedia's REST summary endpoint. Facts are sentence-level on
 * purpose: the fact checker later matches an individual claim against an individual fact, so
 * a single blob of prose would make that check meaningless.
 */
export class WikipediaResearchProvider implements ResearchProvider {
  private readonly fetchImpl: typeof fetch
  private readonly log?: (message: string) => void

  constructor(deps: { fetchImpl?: typeof fetch; log?: (message: string) => void } = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.log = deps.log
  }

  async lookup(query: string, opts?: { maxFacts?: number }): Promise<ResearchFact[]> {
    const slug = encodeURIComponent(query.trim().replace(/\s+/g, '_'))
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`

    let body: SummaryResponse
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      })
      if (!res.ok) {
        this.log?.(`no Wikipedia summary for "${query}" (${res.status})`)
        return []
      }
      body = (await res.json()) as SummaryResponse
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.log?.(`Wikipedia lookup for "${query}" failed: ${detail}`)
      return []
    }

    const extract = body.extract ?? ''
    if (extract.trim().length === 0) return []

    const sourceUrl =
      body.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${slug}`

    // Split on sentence boundaries followed by whitespace and a capital letter, which avoids
    // breaking on decimals and common abbreviations.
    const sentences = extract
      .split(/(?<=[.!?])\s+(?=[A-Z(])/)
      .map((s) => s.trim())
      .filter((s) => s.length >= MIN_FACT_CHARS)

    const limit = opts?.maxFacts ?? 8
    return sentences.slice(0, limit).map((text) => ({ text, sourceUrl }))
  }
}
```

Append to `packages/providers/src/index.ts`:

```ts
export * from './research/wikipedia'
```

- [ ] **Step 6: Run the full suite**

Run: `pnpm test`
Expected: PASS — 5 new provider tests. Any stage test that builds a `ProviderBundle` by hand will now fail to typecheck until it includes `research`; the shared harness uses `createFakeProviders()` so it is already covered.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src packages/providers/src
git commit -m "feat(providers): add a research provider backed by Wikipedia summaries"
```

---

### Task 10: Researcher

Gathers grounding facts with source URLs. This file becomes the sole source of truth for the script — the writer may not introduce facts absent from it. Spec §4 stage 2.

**Files:**
- Create: `packages/pipeline/src/stages/prompts/researcher.ts`
- Create: `packages/pipeline/src/stages/researcher.ts`
- Create: `packages/pipeline/src/stages/researcher.test.ts`
- Modify: `packages/pipeline/src/stages/index.ts`

**Interfaces:**
- Consumes: `topic` artifact (Task 8), `ResearchProvider` (Task 9), `ResearchSchema` (Plan 1)
- Produces: `buildEntityPrompt(input: { title: string; angle: string }): string`; `createResearcherStage(): Stage`; the `research` artifact.

**Design:** ask the model which entities to look up (the subject plus the handful of related things the angle implies), look each up through the research provider, then keep the facts. This is two network round trips rather than one, but it is what turns "one Wikipedia page" into usable grounding for a specific angle.

- [ ] **Step 1: Write the failing test**

Create `packages/pipeline/src/stages/researcher.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ResearchSchema, TopicSchema, type RunContext } from '@yt/core'
import { createResearcherStage, buildEntityPrompt } from '@yt/pipeline'
import { makeStageContext, type StageHarness } from '../../../../test/fixtures/stage-context'

let h: StageHarness

const writeTopic = async (harness: StageHarness) => {
  await harness.ctx.artifacts.write('topic', TopicSchema, {
    key: 'venus',
    title: 'Why Venus rotates backwards',
    source: 'wikipedia-top',
    url: 'https://en.wikipedia.org/wiki/Venus',
    angle: 'Follow the radar measurement that revealed the retrograde spin.',
    scores: { curiosity: 9, explainability: 8, visualPotential: 7, evergreen: 9 },
    total: 33,
  })
}

beforeEach(async () => {
  h = await makeStageContext()
  await writeTopic(h)
})
afterEach(async () => {
  await h.cleanup()
})

describe('buildEntityPrompt', () => {
  it('includes both the title and the angle, so entities serve the chosen take', () => {
    const prompt = buildEntityPrompt({ title: 'Why Venus rotates backwards', angle: 'Follow the radar measurement.' })
    expect(prompt).toContain('Why Venus rotates backwards')
    expect(prompt).toContain('Follow the radar measurement.')
  })
})

describe('createResearcherStage', () => {
  it('writes facts gathered for every entity the model named', async () => {
    h.providers.llm.json = (async () => ({ entities: ['Venus', 'Radar astronomy'] })) as RunContext['providers']['llm']['json']
    const asked: string[] = []
    h.providers.research.lookup = async (query) => {
      asked.push(query)
      return [{ text: `A sufficiently long grounding fact about ${query} here.`, sourceUrl: 'https://en.wikipedia.org/wiki/X' }]
    }

    await expect(createResearcherStage().run(h.ctx)).resolves.toEqual({ status: 'done' })

    expect(asked).toEqual(['Venus', 'Radar astronomy'])
    const research = await h.ctx.artifacts.read('research', ResearchSchema)
    expect(research.topicTitle).toBe('Why Venus rotates backwards')
    expect(research.facts).toHaveLength(2)
  })

  it('always researches the topic title even if the model omits it', async () => {
    h.providers.llm.json = (async () => ({ entities: ['Radar astronomy'] })) as RunContext['providers']['llm']['json']
    const asked: string[] = []
    h.providers.research.lookup = async (query) => {
      asked.push(query)
      return [{ text: `A sufficiently long grounding fact about ${query} here.`, sourceUrl: 'https://en.wikipedia.org/wiki/X' }]
    }

    await createResearcherStage().run(h.ctx)

    expect(asked).toContain('Why Venus rotates backwards')
  })

  it('deduplicates identical facts returned for different entities', async () => {
    h.providers.llm.json = (async () => ({ entities: ['Venus', 'Venus planet'] })) as RunContext['providers']['llm']['json']
    h.providers.research.lookup = async () => [
      { text: 'The very same grounding fact returned twice over.', sourceUrl: 'https://en.wikipedia.org/wiki/Venus' },
    ]

    await createResearcherStage().run(h.ctx)

    const research = await h.ctx.artifacts.read('research', ResearchSchema)
    expect(research.facts).toHaveLength(1)
  })

  it('halts when no entity produced a single fact, since the script would be ungrounded', async () => {
    h.providers.llm.json = (async () => ({ entities: ['Venus'] })) as RunContext['providers']['llm']['json']
    h.providers.research.lookup = async () => []

    const outcome = await createResearcherStage().run(h.ctx)

    expect(outcome).toMatchObject({ status: 'halted' })
    expect((outcome as { reason: string }).reason).toMatch(/no facts|ungrounded/i)
  })

  it('survives one entity lookup failing and keeps the facts from the others', async () => {
    h.providers.llm.json = (async () => ({ entities: ['Good', 'Bad'] })) as RunContext['providers']['llm']['json']
    h.providers.research.lookup = async (query) => {
      if (query === 'Bad') throw new Error('lookup exploded')
      return [{ text: `A sufficiently long grounding fact about ${query} here.`, sourceUrl: 'https://en.wikipedia.org/wiki/X' }]
    }

    const outcome = await createResearcherStage().run(h.ctx)

    expect(outcome).toEqual({ status: 'done' })
    const research = await h.ctx.artifacts.read('research', ResearchSchema)
    expect(research.facts.some((f) => f.text.includes('Good'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/pipeline/src/stages/researcher.test.ts`
Expected: FAIL — `createResearcherStage` is not exported.

- [ ] **Step 3: Write the prompt**

Create `packages/pipeline/src/stages/prompts/researcher.ts`:

```ts
/**
 * Asks which entities to research. Naming the angle matters: for "why Venus rotates
 * backwards" the useful entities include radar astronomy and tidal locking, none of which
 * follow from the title alone.
 */
export const buildEntityPrompt = (input: { title: string; angle: string }): string =>
  `A video is being made with this subject and angle.

Subject: ${input.title}
Angle: ${input.angle}

List the encyclopedia article titles that would need to be read to explain this accurately.
Include the subject itself and between two and five closely related entities that the angle
depends on — a measurement technique, a person, a place, a competing explanation. Do not list
broad categories like "astronomy" or "history"; list specific article titles.

Respond with JSON only:
{ "entities": ["<article title>", "..."] }`
```

- [ ] **Step 4: Write the stage**

Create `packages/pipeline/src/stages/researcher.ts`:

```ts
import { z } from 'zod'
import {
  ResearchSchema,
  STAGE_REQUIREMENTS,
  TopicSchema,
  type ResearchFact,
  type Stage,
} from '@yt/core'
import { buildEntityPrompt } from './prompts/researcher'

const EntitiesSchema = z.object({
  entities: z.array(z.string().min(1)).min(1).max(8),
})

/** Facts per entity. Enough to ground a script without burning the context window. */
const MAX_FACTS_PER_ENTITY = 8

export const createResearcherStage = (): Stage => ({
  name: 'researcher',
  requires: STAGE_REQUIREMENTS.researcher,

  async run(ctx) {
    const topic = await ctx.artifacts.read('topic', TopicSchema)

    const { entities } = await ctx.providers.llm.json(
      buildEntityPrompt({ title: topic.title, angle: topic.angle }),
      'ResearchEntities',
      (raw) => EntitiesSchema.parse(raw),
    )

    // The subject itself is not optional, whatever the model returned.
    const queries = [topic.title, ...entities.filter((e) => e !== topic.title)]
    ctx.log.info(`researching ${queries.length} entities: ${queries.join(', ')}`)

    const facts: ResearchFact[] = []
    const seen = new Set<string>()

    for (const query of queries) {
      try {
        const found = await ctx.providers.research.lookup(query, { maxFacts: MAX_FACTS_PER_ENTITY })
        for (const fact of found) {
          // Related articles repeat each other; a duplicated fact adds no grounding.
          const dedupeKey = fact.text.trim().toLowerCase()
          if (seen.has(dedupeKey)) continue
          seen.add(dedupeKey)
          facts.push(fact)
        }
      } catch (error) {
        // One unavailable article must not lose the facts already gathered.
        const detail = error instanceof Error ? error.message : String(error)
        ctx.log.warn(`research lookup for "${query}" failed and was skipped: ${detail}`)
      }
    }

    if (facts.length === 0) {
      return {
        status: 'halted',
        reason: `found no facts for any of ${queries.length} entities, so the script would be ungrounded`,
      }
    }

    await ctx.artifacts.write('research', ResearchSchema, {
      topicTitle: topic.title,
      facts,
    })

    ctx.log.info(`gathered ${facts.length} grounding facts from ${queries.length} entities`)
    return { status: 'done' }
  },
})
```

- [ ] **Step 5: Export and run**

Append to `packages/pipeline/src/stages/index.ts`:

```ts
export * from './researcher'
export * from './prompts/researcher'
```

Run: `pnpm test`
Expected: PASS — 6 new tests.

- [ ] **Step 6: Commit**

```bash
git add packages/pipeline/src/stages
git commit -m "feat(stages): add Researcher gathering sourced grounding facts"
```

---

### Task 11: ScriptWriter

Fills the eight-section story arc with 15–30 second beats, grounded strictly in the research file. Spec §4 stage 3.

**Files:** create `stages/prompts/script-writer.ts`, `stages/script-writer.ts`, `stages/script-writer.test.ts`; modify `stages/index.ts`.

**Interfaces:**
- Consumes: `topic` and `research` artifacts; `ScriptSchema`, `SECTION_KINDS`, `FormatPreset`
- Produces: `buildScriptPrompt(input: { topicTitle: string; angle: string; facts: string[]; targetSeconds: number; beatsPerSection: number }): string`; `createScriptWriterStage(): Stage`; the `script` artifact.

**The hard part:** a local 8B model will not naturally emit exactly eight sections with every beat between 15 and 30 seconds. Three things make it work: the prompt states the beat budget arithmetic explicitly, `ScriptSchema.parse` rejects anything malformed, and the provider's JSON retry loop re-asks. Do not relax the schema to accommodate the model.

- [ ] **Step 1: Write the failing test**

Create `packages/pipeline/src/stages/script-writer.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ResearchSchema, ScriptSchema, SECTION_KINDS, TopicSchema, type RunContext } from '@yt/core'
import { buildScriptPrompt, createScriptWriterStage } from '@yt/pipeline'
import { makeStageContext, type StageHarness } from '../../../../test/fixtures/stage-context'

let h: StageHarness

const validScript = (beatsPerSection = 3) => ({
  topicTitle: 'Why Venus rotates backwards',
  sections: SECTION_KINDS.map((kind) => ({
    kind,
    beats: Array.from({ length: beatsPerSection }, (_, i) => ({
      id: `${kind}-${i}`,
      text: `Narration for ${kind} beat ${i}.`,
      targetSeconds: 25,
    })),
  })),
})

beforeEach(async () => {
  h = await makeStageContext({ videoType: 'long' })
  await h.ctx.artifacts.write('topic', TopicSchema, {
    key: 'venus',
    title: 'Why Venus rotates backwards',
    source: 'wikipedia-top',
    url: 'https://en.wikipedia.org/wiki/Venus',
    angle: 'Follow the radar measurement that revealed the retrograde spin.',
    scores: { curiosity: 9, explainability: 8, visualPotential: 7, evergreen: 9 },
    total: 33,
  })
  await h.ctx.artifacts.write('research', ResearchSchema, {
    topicTitle: 'Why Venus rotates backwards',
    facts: [
      { text: 'Venus rotates in the opposite direction to most planets in the Solar System.', sourceUrl: 'https://en.wikipedia.org/wiki/Venus' },
      { text: 'Radar observations in the 1960s established the retrograde rotation.', sourceUrl: 'https://en.wikipedia.org/wiki/Radar_astronomy' },
    ],
  })
})
afterEach(async () => {
  await h.cleanup()
})

describe('buildScriptPrompt', () => {
  it('lists every research fact, because the writer may not invent any', () => {
    const prompt = buildScriptPrompt({
      topicTitle: 'T', angle: 'A',
      facts: ['Fact one.', 'Fact two.'],
      targetSeconds: 540, beatsPerSection: 3,
    })
    expect(prompt).toContain('Fact one.')
    expect(prompt).toContain('Fact two.')
  })

  it('names all eight sections in arc order and states the beat window', () => {
    const prompt = buildScriptPrompt({ topicTitle: 'T', angle: 'A', facts: ['f'], targetSeconds: 540, beatsPerSection: 3 })
    for (const kind of SECTION_KINDS) expect(prompt).toContain(kind)
    expect(prompt).toContain('15')
    expect(prompt).toContain('30')
  })

  it('states the per-section beat budget so the arithmetic is not left implicit', () => {
    const prompt = buildScriptPrompt({ topicTitle: 'T', angle: 'A', facts: ['f'], targetSeconds: 540, beatsPerSection: 3 })
    expect(prompt).toContain('3')
    expect(prompt).toContain('540')
  })
})

describe('createScriptWriterStage', () => {
  it('writes a schema-valid script', async () => {
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse(validScript())) as RunContext['providers']['llm']['json']

    await expect(createScriptWriterStage().run(h.ctx)).resolves.toEqual({ status: 'done' })

    const script = await h.ctx.artifacts.read('script', ScriptSchema)
    expect(script.sections).toHaveLength(8)
    expect(script.sections.map((s) => s.kind)).toEqual([...SECTION_KINDS])
  })

  it('asks for a beat budget derived from the format preset, not a fixed number', async () => {
    let seenPrompt = ''
    h.providers.llm.json = (async (p: string, _n: string, parse: (raw: unknown) => unknown) => {
      seenPrompt = p
      return parse(validScript())
    }) as RunContext['providers']['llm']['json']

    await createScriptWriterStage().run(h.ctx)

    // long preset: 480-600s at ~25s per beat over 8 sections is about 3 beats each.
    expect(seenPrompt).toContain('540')
  })

  it('asks for far fewer beats for a shorts run', async () => {
    const shorts = await makeStageContext({ videoType: 'shorts', runId: 'run-shorts' })
    await shorts.ctx.artifacts.write('topic', TopicSchema, await h.ctx.artifacts.read('topic', TopicSchema))
    await shorts.ctx.artifacts.write('research', ResearchSchema, await h.ctx.artifacts.read('research', ResearchSchema))
    let seenPrompt = ''
    shorts.providers.llm.json = (async (p: string, _n: string, parse: (raw: unknown) => unknown) => {
      seenPrompt = p
      return parse({
        topicTitle: 'Why Venus rotates backwards',
        sections: SECTION_KINDS.map((kind) => ({ kind, beats: [{ id: kind, text: `Beat for ${kind}.`, targetSeconds: 15 }] })),
      })
    }) as RunContext['providers']['llm']['json']

    await createScriptWriterStage().run(shorts.ctx)

    expect(seenPrompt).toMatch(/\b(52|53|60)\b/)
    await shorts.cleanup()
  })

  it('propagates a schema rejection rather than writing a malformed script', async () => {
    // A beat outside 15-30s must not reach disk. The provider owns retrying; when it gives
    // up the stage must fail, not persist something invalid.
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse({
        topicTitle: 'T',
        sections: SECTION_KINDS.map((kind) => ({ kind, beats: [{ id: kind, text: 'x', targetSeconds: 90 }] })),
      })) as RunContext['providers']['llm']['json']

    await expect(createScriptWriterStage().run(h.ctx)).rejects.toThrow()
    await expect(h.ctx.artifacts.exists('script')).resolves.toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/pipeline/src/stages/script-writer.test.ts`
Expected: FAIL — `createScriptWriterStage` is not exported.

- [ ] **Step 3: Write the prompt**

Create `packages/pipeline/src/stages/prompts/script-writer.ts`:

```ts
import { SECTION_KINDS } from '@yt/core'

/**
 * The beat budget is stated explicitly because a local model asked for "about nine minutes"
 * produces wildly variable length. Telling it the section count, the per-section beat count
 * and the seconds per beat turns the length target into arithmetic it can follow.
 */
export const buildScriptPrompt = (input: {
  topicTitle: string
  angle: string
  facts: string[]
  targetSeconds: number
  beatsPerSection: number
}): string => {
  const factList = input.facts.map((f, i) => `${i + 1}. ${f}`).join('\n')
  const totalBeats = input.beatsPerSection * SECTION_KINDS.length

  return `Write the narration script for one YouTube video.

Subject: ${input.topicTitle}
Angle: ${input.angle}

STRUCTURE — exactly these ${SECTION_KINDS.length} sections, in this order:
${SECTION_KINDS.map((k, i) => `${i + 1}. ${k}`).join('\n')}

Each section contains beats. A beat is one spoken unit that introduces something new.

LENGTH — the whole video runs about ${input.targetSeconds} seconds:
- ${input.beatsPerSection} beats per section, so about ${totalBeats} beats in total
- every beat's targetSeconds MUST be between 15 and 30 inclusive
- write roughly ${Math.round((input.targetSeconds / totalBeats) * 2.5)} words of narration per beat, since speech runs about 150 words per minute

GROUNDING — you may only state things supported by these facts. Do not add dates, numbers,
names or causes that are not here. If a fact you want is missing, write around it.
${factList}

WRITING — this is spoken narration, not an essay. No headings, no bullet points, no stage
directions, no "in this video". Every beat must introduce something new: a question, a
complication, a reveal, a consequence. The hook has one job, which is making the next beat
unskippable.

Respond with JSON only:
{
  "topicTitle": "${input.topicTitle}",
  "sections": [
    { "kind": "hook", "beats": [ { "id": "hook-1", "text": "<narration>", "targetSeconds": 20 } ] }
  ]
}

Include all ${SECTION_KINDS.length} sections. Give every beat a unique id.`
}
```

- [ ] **Step 4: Write the stage**

Create `packages/pipeline/src/stages/script-writer.ts`:

```ts
import {
  ResearchSchema,
  ScriptSchema,
  SECTION_KINDS,
  STAGE_REQUIREMENTS,
  TopicSchema,
  type Stage,
} from '@yt/core'
import { buildScriptPrompt } from './prompts/script-writer'

/** Midpoint of the schema-permitted 15-30s beat window. */
const SECONDS_PER_BEAT = 25

export const createScriptWriterStage = (): Stage => ({
  name: 'script-writer',
  requires: STAGE_REQUIREMENTS['script-writer'],

  async run(ctx) {
    const topic = await ctx.artifacts.read('topic', TopicSchema)
    const research = await ctx.artifacts.read('research', ResearchSchema)

    // Aim at the middle of the preset's duration window rather than an edge, so a beat or two
    // of drift still lands inside it.
    const targetSeconds = Math.round(
      (ctx.config.preset.minDurationSec + ctx.config.preset.maxDurationSec) / 2,
    )
    const beatsPerSection = Math.max(
      1,
      Math.round(targetSeconds / SECONDS_PER_BEAT / SECTION_KINDS.length),
    )

    ctx.log.info(
      `writing a ~${targetSeconds}s script: ${beatsPerSection} beats per section across ${SECTION_KINDS.length} sections`,
    )

    const script = await ctx.providers.llm.json(
      buildScriptPrompt({
        topicTitle: topic.title,
        angle: topic.angle,
        facts: research.facts.map((f) => f.text),
        targetSeconds,
        beatsPerSection,
      }),
      'Script',
      (raw) => ScriptSchema.parse(raw),
    )

    await ctx.artifacts.write('script', ScriptSchema, script)

    const beats = script.sections.flatMap((s) => s.beats)
    const total = beats.reduce((sum, b) => sum + b.targetSeconds, 0)
    ctx.log.info(`wrote ${beats.length} beats totalling ~${total}s`)
    return { status: 'done' }
  },
})
```

- [ ] **Step 5: Export, run, commit**

Append `export * from './script-writer'` and `export * from './prompts/script-writer'` to `stages/index.ts`.

Run: `pnpm test` — expected PASS (7 new tests).

```bash
git add packages/pipeline/src/stages
git commit -m "feat(stages): add ScriptWriter enforcing the eight-section arc and beat pacing"
```

---

### Task 12: FactChecker

Extracts atomic claims and verifies each against the research file. Halts the run when more than 15% fail, rather than publishing confident nonsense. Spec §4 stage 4.

**Files:** create `stages/prompts/fact-checker.ts`, `stages/fact-checker.ts`, `stages/fact-checker.test.ts`; modify `stages/index.ts`.

**Interfaces:**
- Consumes: `script` and `research` artifacts; `FactCheckSchema`, `MAX_FAILURE_RATIO`
- Produces: `buildFactCheckPrompt(input: { beats: string[]; facts: string[] }): string`; `createFactCheckerStage(): Stage`; the `factcheck` artifact.

- [ ] **Step 1: Write the failing test**

Create `packages/pipeline/src/stages/fact-checker.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FactCheckSchema, MAX_FAILURE_RATIO, ResearchSchema, ScriptSchema, SECTION_KINDS, type RunContext } from '@yt/core'
import { buildFactCheckPrompt, createFactCheckerStage } from '@yt/pipeline'
import { makeStageContext, type StageHarness } from '../../../../test/fixtures/stage-context'

let h: StageHarness

const claims = (supported: number, failed: number) => ({
  claims: [
    ...Array.from({ length: supported }, (_, i) => ({
      text: `Supported claim ${i}.`,
      verdict: 'supported' as const,
      sourceUrl: 'https://en.wikipedia.org/wiki/Venus',
    })),
    ...Array.from({ length: failed }, (_, i) => ({
      text: `Unsupported claim ${i}.`,
      verdict: 'unsupported' as const,
    })),
  ],
})

beforeEach(async () => {
  h = await makeStageContext()
  await h.ctx.artifacts.write('script', ScriptSchema, {
    topicTitle: 'Why Venus rotates backwards',
    sections: SECTION_KINDS.map((kind) => ({
      kind,
      beats: [{ id: kind, text: `Narration for ${kind}.`, targetSeconds: 20 }],
    })),
  })
  await h.ctx.artifacts.write('research', ResearchSchema, {
    topicTitle: 'Why Venus rotates backwards',
    facts: [{ text: 'Venus rotates in the opposite direction to most planets.', sourceUrl: 'https://en.wikipedia.org/wiki/Venus' }],
  })
})
afterEach(async () => {
  await h.cleanup()
})

describe('buildFactCheckPrompt', () => {
  it('includes both the narration and the facts it must be checked against', () => {
    const prompt = buildFactCheckPrompt({ beats: ['Narration one.'], facts: ['Fact one.'] })
    expect(prompt).toContain('Narration one.')
    expect(prompt).toContain('Fact one.')
  })

  it('names all three verdicts', () => {
    const prompt = buildFactCheckPrompt({ beats: ['b'], facts: ['f'] })
    for (const v of ['supported', 'unsupported', 'contradicted']) expect(prompt).toContain(v)
  })
})

describe('createFactCheckerStage', () => {
  it('writes the report and continues when everything is supported', async () => {
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse(claims(10, 0))) as RunContext['providers']['llm']['json']

    await expect(createFactCheckerStage().run(h.ctx)).resolves.toEqual({ status: 'done' })

    const report = await h.ctx.artifacts.read('factcheck', FactCheckSchema)
    expect(report.failureRatio).toBe(0)
    expect(report.claims).toHaveLength(10)
  })

  it('computes the failure ratio from unsupported and contradicted claims together', async () => {
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse(claims(9, 1))) as RunContext['providers']['llm']['json']

    await createFactCheckerStage().run(h.ctx)

    const report = await h.ctx.artifacts.read('factcheck', FactCheckSchema)
    expect(report.failureRatio).toBeCloseTo(0.1)
  })

  it('halts when the failure ratio exceeds the threshold', async () => {
    // 8 supported, 2 failed = 0.2, above the 0.15 threshold.
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse(claims(8, 2))) as RunContext['providers']['llm']['json']

    const outcome = await createFactCheckerStage().run(h.ctx)

    expect(outcome).toMatchObject({ status: 'halted' })
    expect((outcome as { reason: string }).reason).toContain('20')
  })

  it('still writes the report when it halts, so the failure is inspectable', async () => {
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse(claims(8, 2))) as RunContext['providers']['llm']['json']

    await createFactCheckerStage().run(h.ctx)

    await expect(h.ctx.artifacts.exists('factcheck')).resolves.toBe(true)
  })

  it('accepts a ratio exactly at the threshold rather than halting on it', async () => {
    // 17 supported, 3 failed = 0.15 exactly. The rule is "more than 15%".
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse(claims(17, 3))) as RunContext['providers']['llm']['json']

    const outcome = await createFactCheckerStage().run(h.ctx)

    expect(outcome).toEqual({ status: 'done' })
    expect(MAX_FAILURE_RATIO).toBe(0.15)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/pipeline/src/stages/fact-checker.test.ts` — expected FAIL, not exported.

- [ ] **Step 3: Write the prompt**

Create `packages/pipeline/src/stages/prompts/fact-checker.ts`:

```ts
export const buildFactCheckPrompt = (input: { beats: string[]; facts: string[] }): string => `You are fact-checking narration against the only sources permitted for it.

Extract every factual claim the narration makes — a date, a number, a cause, an attribution, a
superlative. Rhetorical questions and opinions are not claims. Then judge each claim against
the facts below and nothing else. Your own knowledge does not count as support here: the point
is whether the script is grounded in its sources.

Verdicts:
- "supported": the facts state this, or it follows directly from them
- "unsupported": the facts neither state nor contradict it
- "contradicted": the facts say otherwise

NARRATION:
${input.beats.map((b, i) => `[${i + 1}] ${b}`).join('\n')}

PERMITTED FACTS:
${input.facts.map((f, i) => `(${i + 1}) ${f}`).join('\n')}

Respond with JSON only:
{
  "claims": [
    { "text": "<the claim, quoted or closely paraphrased>", "verdict": "supported", "sourceUrl": "<omit unless supported>" }
  ]
}

Include every claim you found. Do not include a sourceUrl for an unsupported or contradicted claim.`
```

- [ ] **Step 4: Write the stage**

Create `packages/pipeline/src/stages/fact-checker.ts`:

```ts
import { z } from 'zod'
import {
  FactCheckSchema,
  MAX_FAILURE_RATIO,
  ResearchSchema,
  ScriptSchema,
  STAGE_REQUIREMENTS,
  type Stage,
} from '@yt/core'
import { buildFactCheckPrompt } from './prompts/fact-checker'

const ClaimsSchema = z.object({
  claims: z
    .array(
      z.object({
        text: z.string().min(1),
        verdict: z.enum(['supported', 'unsupported', 'contradicted']),
        sourceUrl: z.string().url().optional(),
      }),
    )
    .min(1),
})

export const createFactCheckerStage = (): Stage => ({
  name: 'fact-checker',
  requires: STAGE_REQUIREMENTS['fact-checker'],

  async run(ctx) {
    const script = await ctx.artifacts.read('script', ScriptSchema)
    const research = await ctx.artifacts.read('research', ResearchSchema)

    const beats = script.sections.flatMap((s) => s.beats.map((b) => b.text))
    const { claims } = await ctx.providers.llm.json(
      buildFactCheckPrompt({ beats, facts: research.facts.map((f) => f.text) }),
      'FactCheckClaims',
      (raw) => ClaimsSchema.parse(raw),
    )

    const failed = claims.filter((c) => c.verdict !== 'supported').length
    const failureRatio = failed / claims.length

    // Written even when the run halts: the whole point of stopping is that someone can look
    // at what failed.
    await ctx.artifacts.write('factcheck', FactCheckSchema, { claims, failureRatio })

    const percent = Math.round(failureRatio * 100)
    ctx.log.info(`checked ${claims.length} claims; ${failed} not supported (${percent}%)`)

    if (failureRatio > MAX_FAILURE_RATIO) {
      return {
        status: 'halted',
        reason:
          `${failed} of ${claims.length} claims are unsupported or contradicted (${percent}%), ` +
          `above the ${Math.round(MAX_FAILURE_RATIO * 100)}% threshold — the script is not grounded in its sources`,
      }
    }

    return { status: 'done' }
  },
})
```

- [ ] **Step 5: Export, run, commit**

Append the two exports to `stages/index.ts`. Run `pnpm test` — expected PASS (7 new tests).

```bash
git add packages/pipeline/src/stages
git commit -m "feat(stages): add FactChecker halting an ungrounded script"
```

---

### Task 13: ScenePlanner

Splits the script into scenes, assigns each a visual directive and camera move, and enforces the image budget. Spec §4 stage 5.

**Files:** create `stages/prompts/scene-planner.ts`, `stages/scene-planner.ts`, `stages/scene-planner.test.ts`; modify `stages/index.ts`.

**Interfaces:**
- Consumes: `script` artifact; `ScenePlanSchema`, `CAMERA_MOVES`, `FormatPreset`, `ClipsConfig`
- Produces: `buildScenePlanPrompt(input: { beats: { id: string; text: string; sectionKind: string }[]; styleSuffix: string; imageBudget: number; clipBudget: number; clipSections: string[] }): string`; `createScenePlannerStage(): Stage`; the `scenes` artifact.

**Rules the stage enforces after the model answers**, because a model will not respect budgets reliably:
- At most `preset.imageBudget` scenes may be `sd-image`. Excess ones are rewritten to `reuse` pointing at the nearest earlier `sd-image` scene.
- At most `clips.budget[videoType]` scenes may be `veo-clip`, and only within `clips.placement` sections. Excess or misplaced ones become `sd-image`.
- Every `veo-clip` must carry a `fallbackPrompt`; if the model omitted one, synthesise it from the scene text so a missing clip degrades to an image rather than blocking the run.
- Scene count must land inside `[preset.minScenes, preset.maxScenes]`; if it is short, that is acceptable, but if it exceeds the maximum, halt rather than render a video with hundreds of cuts.

- [ ] **Step 1: Write the failing test**

Create `packages/pipeline/src/stages/scene-planner.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ScenePlanSchema, ScriptSchema, SECTION_KINDS, type RunContext } from '@yt/core'
import { buildScenePlanPrompt, createScenePlannerStage } from '@yt/pipeline'
import { makeStageContext, type StageHarness } from '../../../../test/fixtures/stage-context'

let h: StageHarness

const scriptWith = (beatsPerSection: number) => ({
  topicTitle: 'Why Venus rotates backwards',
  sections: SECTION_KINDS.map((kind) => ({
    kind,
    beats: Array.from({ length: beatsPerSection }, (_, i) => ({
      id: `${kind}-${i}`,
      text: `Narration for ${kind} beat ${i}.`,
      targetSeconds: 25,
    })),
  })),
})

const sceneFor = (beatId: string, visual: unknown) => ({
  id: `scene-${beatId}`,
  beatId,
  text: `Narration for ${beatId}.`,
  visual,
  camera: 'zoom-in' as const,
})

beforeEach(async () => {
  h = await makeStageContext({ videoType: 'shorts' })
  await h.ctx.artifacts.write('script', ScriptSchema, scriptWith(1))
})
afterEach(async () => {
  await h.cleanup()
})

describe('buildScenePlanPrompt', () => {
  it('states the image and clip budgets and the niche style suffix', () => {
    const prompt = buildScenePlanPrompt({
      beats: [{ id: 'hook-0', text: 'A beat.', sectionKind: 'hook' }],
      styleSuffix: 'cinematic astrophotography',
      imageBudget: 10,
      clipBudget: 2,
      clipSections: ['hook', 'reveal'],
    })
    expect(prompt).toContain('cinematic astrophotography')
    expect(prompt).toContain('10')
    expect(prompt).toContain('2')
    expect(prompt).toContain('hook')
  })
})

describe('createScenePlannerStage', () => {
  it('writes a schema-valid scene plan', async () => {
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse({
        scenes: SECTION_KINDS.map((k) => sceneFor(`${k}-0`, { kind: 'sd-image', prompt: `An image for ${k}` })),
      })) as RunContext['providers']['llm']['json']

    await expect(createScenePlannerStage().run(h.ctx)).resolves.toEqual({ status: 'done' })

    const plan = await h.ctx.artifacts.read('scenes', ScenePlanSchema)
    expect(plan.scenes).toHaveLength(8)
  })

  it('rewrites images beyond the budget as reuse of an earlier image', async () => {
    // The shorts preset allows 10 images. Two beats per section gives 16 scenes, so six of
    // them must be downgraded to reuse.
    await h.ctx.artifacts.write('script', ScriptSchema, scriptWith(2))
    const allBeats = scriptWith(2).sections.flatMap((s) => s.beats.map((b) => b.id))
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse({ scenes: allBeats.map((b) => sceneFor(b, { kind: 'sd-image', prompt: `Image ${b}` })) })) as RunContext['providers']['llm']['json']

    await createScenePlannerStage().run(h.ctx)

    const plan = await h.ctx.artifacts.read('scenes', ScenePlanSchema)
    const images = plan.scenes.filter((s) => s.visual.kind === 'sd-image')
    const reuses = plan.scenes.filter((s) => s.visual.kind === 'reuse')
    expect(images.length).toBeLessThanOrEqual(h.ctx.config.preset.imageBudget)
    expect(reuses.length).toBeGreaterThan(0)
    // Every reuse must point at a scene that really exists and really holds an image.
    const imageIds = new Set(images.map((s) => s.id))
    for (const r of reuses) {
      expect(imageIds.has((r.visual as { sceneId: string }).sceneId)).toBe(true)
    }
  })

  it('gives every veo-clip a fallback prompt even when the model omitted one', async () => {
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse({
        scenes: SECTION_KINDS.map((k, i) =>
          i === 0
            ? sceneFor(`${k}-0`, { kind: 'veo-clip', prompt: 'A dust storm rolling in', referenceSceneId: 'scene-hook-0', fallbackPrompt: '' })
            : sceneFor(`${k}-0`, { kind: 'sd-image', prompt: `Image ${k}` }),
        ),
      })) as RunContext['providers']['llm']['json']

    await createScenePlannerStage().run(h.ctx)

    const plan = await h.ctx.artifacts.read('scenes', ScenePlanSchema)
    const clip = plan.scenes.find((s) => s.visual.kind === 'veo-clip')
    expect(clip).toBeDefined()
    expect((clip!.visual as { fallbackPrompt: string }).fallbackPrompt.length).toBeGreaterThan(0)
  })

  it('converts a veo-clip placed outside the configured sections into an image', async () => {
    // clips.placement defaults to hook, reveal, twist. 'conclusion' is not permitted.
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse({
        scenes: SECTION_KINDS.map((k) =>
          k === 'conclusion'
            ? sceneFor(`${k}-0`, { kind: 'veo-clip', prompt: 'A clip', referenceSceneId: 'scene-hook-0', fallbackPrompt: 'A fallback' })
            : sceneFor(`${k}-0`, { kind: 'sd-image', prompt: `Image ${k}` }),
        ),
      })) as RunContext['providers']['llm']['json']

    await createScenePlannerStage().run(h.ctx)

    const plan = await h.ctx.artifacts.read('scenes', ScenePlanSchema)
    const conclusion = plan.scenes.find((s) => s.beatId === 'conclusion-0')!
    expect(conclusion.visual.kind).toBe('sd-image')
  })

  it('halts when the model returns more scenes than the preset allows', async () => {
    const many = Array.from({ length: 200 }, (_, i) => sceneFor(`x-${i}`, { kind: 'sd-image', prompt: `Image ${i}` }))
    h.providers.llm.json = (async (_p: string, _n: string, parse: (raw: unknown) => unknown) =>
      parse({ scenes: many })) as RunContext['providers']['llm']['json']

    const outcome = await createScenePlannerStage().run(h.ctx)

    expect(outcome).toMatchObject({ status: 'halted' })
    expect((outcome as { reason: string }).reason).toMatch(/scene/i)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/pipeline/src/stages/scene-planner.test.ts` — expected FAIL, not exported.

- [ ] **Step 3: Write the prompt**

Create `packages/pipeline/src/stages/prompts/scene-planner.ts`:

```ts
import { CAMERA_MOVES } from '@yt/core'

export const buildScenePlanPrompt = (input: {
  beats: { id: string; text: string; sectionKind: string }[]
  styleSuffix: string
  imageBudget: number
  clipBudget: number
  clipSections: string[]
}): string => `Plan the visuals for a narrated video. One scene per beat.

For each scene choose exactly one visual:
- "sd-image": a generated still. Write an image prompt describing a concrete subject, setting
  and lighting. Never describe text, captions or words in the image.
- "motion-graphic": data rather than a photograph. Pick a variant: timeline, map, stat, quote, list.
- "reuse": show an earlier scene's image again under a different camera move.
- "veo-clip": a short generated video clip. Only for high-impact moments.

Also choose a camera move from: ${CAMERA_MOVES.join(', ')}.

BUDGETS — these are hard limits:
- at most ${input.imageBudget} scenes may be "sd-image"
- at most ${input.clipBudget} scenes may be "veo-clip", and only in these sections: ${input.clipSections.join(', ')}
- use "reuse" and "motion-graphic" for the rest; a video that is only generated stills looks like a slideshow

Every image prompt must end with this style, so the video looks like one piece: ${input.styleSuffix}

BEATS:
${input.beats.map((b) => `[${b.id}] (${b.sectionKind}) ${b.text}`).join('\n')}

Respond with JSON only:
{
  "scenes": [
    {
      "id": "scene-1",
      "beatId": "<the beat id above>",
      "text": "<the beat's narration, copied>",
      "visual": { "kind": "sd-image", "prompt": "<image prompt>, ${input.styleSuffix}" },
      "camera": "zoom-in"
    }
  ]
}

For "motion-graphic" use { "kind": "motion-graphic", "variant": "timeline", "payload": {} }.
For "reuse" use { "kind": "reuse", "sceneId": "<an earlier scene id>" }.
For "veo-clip" use { "kind": "veo-clip", "prompt": "<motion description>", "referenceSceneId": "<an earlier scene id>", "fallbackPrompt": "<a still image prompt to use if no clip arrives>" }.
Produce exactly one scene per beat, in beat order.`
```

- [ ] **Step 4: Write the stage**

Create `packages/pipeline/src/stages/scene-planner.ts`:

```ts
import {
  ScenePlanSchema,
  ScriptSchema,
  STAGE_REQUIREMENTS,
  type Scene,
  type SceneVisual,
  type Stage,
} from '@yt/core'
import { buildScenePlanPrompt } from './prompts/scene-planner'

export const createScenePlannerStage = (): Stage => ({
  name: 'scene-planner',
  requires: STAGE_REQUIREMENTS['scene-planner'],

  async run(ctx) {
    const script = await ctx.artifacts.read('script', ScriptSchema)
    const preset = ctx.config.preset
    const clipBudget = ctx.config.clips.enabled ? ctx.config.clips.budget[preset.format] : 0
    const clipSections = ctx.config.clips.placement as readonly string[]

    const beats = script.sections.flatMap((s) =>
      s.beats.map((b) => ({ id: b.id, text: b.text, sectionKind: s.kind })),
    )
    const sectionOfBeat = new Map(beats.map((b) => [b.id, b.sectionKind]))

    const plan = await ctx.providers.llm.json(
      buildScenePlanPrompt({
        beats,
        styleSuffix: ctx.config.nicheConfig.styleSuffix,
        imageBudget: preset.imageBudget,
        clipBudget,
        clipSections: [...clipSections],
      }),
      'ScenePlan',
      (raw) => ScenePlanSchema.parse(raw),
    )

    if (plan.scenes.length > preset.maxScenes) {
      return {
        status: 'halted',
        reason: `the plan has ${plan.scenes.length} scenes but the ${preset.format} preset allows at most ${preset.maxScenes}`,
      }
    }

    // A model will not respect the budgets reliably, so enforce them here. Doing it after the
    // fact rather than re-prompting keeps the run cheap and the outcome deterministic.
    let imagesUsed = 0
    let clipsUsed = 0
    let lastImageSceneId: string | null = null
    let downgradedImages = 0
    let downgradedClips = 0

    const scenes: Scene[] = plan.scenes.map((scene) => {
      let visual: SceneVisual = scene.visual

      if (visual.kind === 'veo-clip') {
        const section = sectionOfBeat.get(scene.beatId)
        const allowed = clipsUsed < clipBudget && section !== undefined && clipSections.includes(section)
        if (allowed) {
          clipsUsed += 1
          // A clip must always be able to degrade to an image, or a missing clip blocks the run.
          visual = {
            ...visual,
            fallbackPrompt:
              visual.fallbackPrompt.trim().length > 0
                ? visual.fallbackPrompt
                : `${scene.text} — ${ctx.config.nicheConfig.styleSuffix}`,
          }
        } else {
          downgradedClips += 1
          visual = { kind: 'sd-image', prompt: `${visual.fallbackPrompt || scene.text}, ${ctx.config.nicheConfig.styleSuffix}` }
        }
      }

      if (visual.kind === 'sd-image') {
        if (imagesUsed < preset.imageBudget) {
          imagesUsed += 1
          lastImageSceneId = scene.id
        } else if (lastImageSceneId !== null) {
          downgradedImages += 1
          visual = { kind: 'reuse', sceneId: lastImageSceneId }
        }
        // With no earlier image to reuse, keep it: an over-budget first image is better than
        // a reuse pointing at nothing.
      }

      return { ...scene, visual }
    })

    await ctx.artifacts.write('scenes', ScenePlanSchema, { scenes })

    ctx.log.info(
      `planned ${scenes.length} scenes: ${imagesUsed} images (budget ${preset.imageBudget}), ` +
        `${clipsUsed} clips (budget ${clipBudget}), ${downgradedImages} reused, ${downgradedClips} clips downgraded`,
    )
    return { status: 'done' }
  },
})
```

- [ ] **Step 5: Export, run, commit**

Append the two exports to `stages/index.ts`. Run `pnpm test` — expected PASS (6 new tests).

```bash
git add packages/pipeline/src/stages
git commit -m "feat(stages): add ScenePlanner enforcing image and clip budgets"
```

---

### Task 14: SEO

Twenty scored titles, the winner chosen automatically, plus description, tags and hashtags inside YouTube's limits. Spec §4 stage 6.

**Files:** create `stages/prompts/seo.ts`, `stages/seo.ts`, `stages/seo.test.ts`; modify `stages/index.ts`.

**Interfaces:**
- Consumes: `topic`, `script` artifacts; `SeoSchema`, `MAX_TITLE_CHARS`, `MAX_DESCRIPTION_CHARS`, `MAX_TAGS_CHARS`
- Produces: `buildSeoPrompt(input: { topicTitle: string; angle: string; beats: string[]; seoRules: string }): string`; `createSeoStage(): Stage`; the `seo` artifact.

**Enforcement after the model answers**, because `SeoSchema` requires exactly 20 titles and a winner drawn from them: drop titles over 100 characters, pad by truncating others if fewer than 20 survive, pick the highest total as `chosenTitle` regardless of what the model said, and trim tags until the total is within 500 characters.

- [ ] **Step 1: Write the failing test**

Create `packages/pipeline/src/stages/seo.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_TAGS_CHARS, MAX_TITLE_CHARS, ScriptSchema, SECTION_KINDS, SeoSchema, TopicSchema, type RunContext } from '@yt/core'
import { buildSeoPrompt, createSeoStage } from '@yt/pipeline'
import { makeStageContext, type StageHarness } from '../../../../test/fixtures/stage-context'

let h: StageHarness

const titles = (count: number, opts: { overlong?: boolean } = {}) =>
  Array.from({ length: count }, (_, i) => ({
    title: opts.overlong && i === 0 ? 'x'.repeat(120) : `Candidate title number ${i}`,
    scores: { curiosity: i % 10, searchIntent: 5, simplicity: 5, ctr: 5 },
    total: (i % 10) + 15,
  }))

beforeEach(async () => {
  h = await makeStageContext()
  await h.ctx.artifacts.write('topic', TopicSchema, {
    key: 'venus', title: 'Why Venus rotates backwards', source: 'wikipedia-top',
    url: 'https://en.wikipedia.org/wiki/Venus',
    angle: 'Follow the radar measurement.',
    scores: { curiosity: 9, explainability: 8, visualPotential: 7, evergreen: 9 }, total: 33,
  })
  await h.ctx.artifacts.write('script', ScriptSchema, {
    topicTitle: 'Why Venus rotates backwards',
    sections: SECTION_KINDS.map((kind) => ({ kind, beats: [{ id: kind, text: `Narration for ${kind}.`, targetSeconds: 20 }] })),
  })
})
afterEach(async () => {
  await h.cleanup()
})

describe('buildSeoPrompt', () => {
  it('includes the niche SEO rules and the four scoring dimensions', () => {
    const prompt = buildSeoPrompt({ topicTitle: 'T', angle: 'A', beats: ['b'], seoRules: 'Lead with the object.' })
    expect(prompt).toContain('Lead with the object.')
    for (const dim of ['curiosity', 'searchIntent', 'simplicity', 'ctr']) expect(prompt).toContain(dim)
  })

  it('states the twenty-title requirement and the character limits', () => {
    const prompt = buildSeoPrompt({ topicTitle: 'T', angle: 'A', beats: ['b'], seoRules: 'r' })
    expect(prompt).toContain('20')
    expect(prompt).toContain(String(MAX_TITLE_CHARS))
  })
})

describe('createSeoStage', () => {
  it('writes twenty titles and picks the highest scoring one', async () => {
    h.providers.llm.json = (async () => ({
      titles: titles(20), description: 'A description.', tags: ['venus', 'space'], hashtags: ['#space'],
    })) as RunContext['providers']['llm']['json']

    await expect(createSeoStage().run(h.ctx)).resolves.toEqual({ status: 'done' })

    const seo = await h.ctx.artifacts.read('seo', SeoSchema)
    expect(seo.titles).toHaveLength(20)
    const best = [...seo.titles].sort((a, b) => b.total - a.total)[0]!
    expect(seo.chosenTitle).toBe(best.title)
  })

  it('overrides the model when it names a title that is not the best scoring one', async () => {
    h.providers.llm.json = (async () => ({
      titles: titles(20), chosenTitle: 'Candidate title number 0',
      description: 'A description.', tags: ['a'], hashtags: ['#a'],
    })) as RunContext['providers']['llm']['json']

    await createSeoStage().run(h.ctx)

    const seo = await h.ctx.artifacts.read('seo', SeoSchema)
    expect(seo.chosenTitle).not.toBe('Candidate title number 0')
  })

  it('discards titles over the character limit and still writes twenty', async () => {
    h.providers.llm.json = (async () => ({
      titles: titles(21, { overlong: true }), description: 'A description.', tags: ['a'], hashtags: ['#a'],
    })) as RunContext['providers']['llm']['json']

    await createSeoStage().run(h.ctx)

    const seo = await h.ctx.artifacts.read('seo', SeoSchema)
    expect(seo.titles).toHaveLength(20)
    expect(seo.titles.every((t) => t.title.length <= MAX_TITLE_CHARS)).toBe(true)
  })

  it('trims tags until the total is within the limit', async () => {
    h.providers.llm.json = (async () => ({
      titles: titles(20), description: 'A description.',
      tags: Array.from({ length: 60 }, (_, i) => `tag-number-${i}-padded-out`), hashtags: ['#a'],
    })) as RunContext['providers']['llm']['json']

    await createSeoStage().run(h.ctx)

    const seo = await h.ctx.artifacts.read('seo', SeoSchema)
    expect(seo.tags.join(',').length).toBeLessThanOrEqual(MAX_TAGS_CHARS)
    expect(seo.tags.length).toBeGreaterThan(0)
  })

  it('truncates an over-long description rather than failing the run', async () => {
    h.providers.llm.json = (async () => ({
      titles: titles(20), description: 'x'.repeat(6000), tags: ['a'], hashtags: ['#a'],
    })) as RunContext['providers']['llm']['json']

    await createSeoStage().run(h.ctx)

    const seo = await h.ctx.artifacts.read('seo', SeoSchema)
    expect(seo.description.length).toBeLessThanOrEqual(5000)
  })

  it('halts when fewer than twenty usable titles can be assembled', async () => {
    h.providers.llm.json = (async () => ({
      titles: titles(3), description: 'A description.', tags: ['a'], hashtags: ['#a'],
    })) as RunContext['providers']['llm']['json']

    const outcome = await createSeoStage().run(h.ctx)

    expect(outcome).toMatchObject({ status: 'halted' })
  })
})
```

- [ ] **Step 2: Run it to verify it fails** — `pnpm vitest run packages/pipeline/src/stages/seo.test.ts`, expected FAIL.

- [ ] **Step 3: Write the prompt**

Create `packages/pipeline/src/stages/prompts/seo.ts`:

```ts
import { MAX_DESCRIPTION_CHARS, MAX_TITLE_CHARS } from '@yt/core'

export const buildSeoPrompt = (input: {
  topicTitle: string
  angle: string
  beats: string[]
  seoRules: string
}): string => `Write the YouTube metadata for this video.

Subject: ${input.topicTitle}
Angle: ${input.angle}
Channel SEO rules: ${input.seoRules}

Produce exactly 20 title candidates. Vary the approach across them — a question, a number, a
counterintuitive statement, a plain descriptive one. Score each from 0 to 10 on:
- curiosity: does it make someone need the answer
- searchIntent: would someone actually type this
- simplicity: is it instantly readable at a glance
- ctr: would it earn the click against similar videos

Every title must be at most ${MAX_TITLE_CHARS} characters. Do not use ALL CAPS or clickbait
that the video does not deliver on.

Also write a description of at most ${MAX_DESCRIPTION_CHARS} characters that says what the
video covers in its first two lines, then a short list of the sections. Add up to 15 tags
(plain lowercase keywords, no "#") and up to 5 hashtags (with "#").

NARRATION, for context:
${input.beats.map((b, i) => `[${i + 1}] ${b}`).join('\n')}

Respond with JSON only:
{
  "titles": [ { "title": "<text>", "scores": { "curiosity": 0, "searchIntent": 0, "simplicity": 0, "ctr": 0 }, "total": 0 } ],
  "description": "<text>",
  "tags": ["keyword"],
  "hashtags": ["#keyword"]
}

"total" must be the sum of the four scores. Provide all 20 titles.`
```

- [ ] **Step 4: Write the stage**

Create `packages/pipeline/src/stages/seo.ts`:

```ts
import { z } from 'zod'
import {
  MAX_DESCRIPTION_CHARS,
  MAX_TAGS_CHARS,
  MAX_TITLE_CHARS,
  ScriptSchema,
  SeoSchema,
  STAGE_REQUIREMENTS,
  TopicSchema,
  type Stage,
  type TitleCandidate,
} from '@yt/core'
import { buildSeoPrompt } from './prompts/seo'

const REQUIRED_TITLES = 20

const DraftSchema = z.object({
  titles: z
    .array(
      z.object({
        title: z.string().min(1),
        scores: z.object({
          curiosity: z.number().min(0).max(10),
          searchIntent: z.number().min(0).max(10),
          simplicity: z.number().min(0).max(10),
          ctr: z.number().min(0).max(10),
        }),
        total: z.number().min(0).max(40),
      }),
    )
    .min(1),
  description: z.string().min(1),
  tags: z.array(z.string().min(1)),
  hashtags: z.array(z.string().min(1)),
})

/** Drop tags from the end until the comma-joined total fits YouTube's limit. */
const fitTags = (tags: string[]): string[] => {
  const kept: string[] = []
  for (const tag of tags) {
    const candidate = [...kept, tag]
    if (candidate.join(',').length > MAX_TAGS_CHARS) break
    kept.push(tag)
  }
  return kept
}

export const createSeoStage = (): Stage => ({
  name: 'seo',
  requires: STAGE_REQUIREMENTS.seo,

  async run(ctx) {
    const topic = await ctx.artifacts.read('topic', TopicSchema)
    const script = await ctx.artifacts.read('script', ScriptSchema)

    const draft = await ctx.providers.llm.json(
      buildSeoPrompt({
        topicTitle: topic.title,
        angle: topic.angle,
        beats: script.sections.flatMap((s) => s.beats.map((b) => b.text)),
        seoRules: ctx.config.nicheConfig.seoRules,
      }),
      'SeoDraft',
      (raw) => DraftSchema.parse(raw),
    )

    // An over-long title is unusable, so discard rather than truncate: a title cut mid-word
    // scores badly for the very reasons it was scored on.
    const usable: TitleCandidate[] = draft.titles
      .filter((t) => t.title.length <= MAX_TITLE_CHARS)
      .slice(0, REQUIRED_TITLES)

    if (usable.length < REQUIRED_TITLES) {
      return {
        status: 'halted',
        reason: `only ${usable.length} of ${draft.titles.length} titles were usable, need ${REQUIRED_TITLES}`,
      }
    }

    // Trust the scores over the stated choice, exactly as TopicScout does.
    const chosen = [...usable].sort((a, b) => b.total - a.total)[0]!

    const seo = {
      titles: usable,
      chosenTitle: chosen.title,
      description: draft.description.slice(0, MAX_DESCRIPTION_CHARS),
      tags: fitTags(draft.tags),
      hashtags: draft.hashtags,
    }

    await ctx.artifacts.write('seo', SeoSchema, seo)

    ctx.log.info(`chose "${chosen.title}" (${chosen.total}/40) from ${usable.length} candidates`)
    return { status: 'done' }
  },
})
```

- [ ] **Step 5: Export, run, commit**

Append the two exports to `stages/index.ts`. Run `pnpm test` — expected PASS (8 new tests).

```bash
git add packages/pipeline/src/stages
git commit -m "feat(stages): add SEO scoring twenty titles and enforcing metadata limits"
```

---

### Task 15: Wire the real stages and prove the LLM block end to end

**Files:**
- Create: `packages/pipeline/src/stages/build.ts`
- Modify: `packages/pipeline/src/cli.ts`
- Modify: `package.json` (add `test:integration`)
- Create: `vitest.integration.config.ts`
- Create: `test/integration/llm-block.integration.test.ts`
- Modify: `test/e2e/fake-pipeline.test.ts`

**Interfaces:**
- Produces: `buildLlmStages(): Stage[]` returning the six in canonical order; `RunPipelineOptions` gains `llm?: LlmProvider`, `trend?: TrendProvider`, `research?: ResearchProvider` overrides; `pnpm test:integration`.

- [ ] **Step 1: Write the stage builder**

Create `packages/pipeline/src/stages/build.ts`:

```ts
import type { Stage } from '@yt/core'
import { createFactCheckerStage } from './fact-checker'
import { createResearcherStage } from './researcher'
import { createScenePlannerStage } from './scene-planner'
import { createScriptWriterStage } from './script-writer'
import { createSeoStage } from './seo'
import { createTopicScoutStage } from './topic-scout'

/**
 * The six LLM-resident stages, in canonical order. StageRunner validates that a stage list is
 * a leading prefix of STAGE_NAMES, so this is directly runnable as a partial pipeline until
 * later plans add the media and render stages.
 */
export const buildLlmStages = (): Stage[] => [
  createTopicScoutStage(),
  createResearcherStage(),
  createScriptWriterStage(),
  createFactCheckerStage(),
  createScenePlannerStage(),
  createSeoStage(),
]
```

Append `export * from './build'` to `stages/index.ts`.

- [ ] **Step 2: Default the CLI to the real stages**

In `packages/pipeline/src/cli.ts`, change the stage default from `buildNoopStages()` to `buildLlmStages()` and import it. Keep `buildNoopStages` exported — the e2e fake tests still use it explicitly.

Then in `test/e2e/fake-pipeline.test.ts`, every existing test that expects fourteen stages must now pass `stages: buildNoopStages()` explicitly, since the default changed. Import `buildNoopStages` there. **Note this now collides with Task 14's guard from Plan 1** (`useFakes` may not be combined with explicit `stages`) — so those tests must switch from `useFakes: true` to passing `providers: createFakeProviders()` explicitly alongside `stages`. Make that change and confirm the guard's own two tests still pass.

- [ ] **Step 3: Add provider overrides to `runPipeline`**

Add to `RunPipelineOptions`:

```ts
  /** Override individual providers while keeping fakes for the rest. Used by the integration suite. */
  llm?: LlmProvider
  trend?: TrendProvider
  research?: ResearchProvider
```

and after the bundle is built:

```ts
  const providers: ProviderBundle = {
    ...baseProviders,
    ...(opts.llm ? { llm: opts.llm } : {}),
    ...(opts.trend ? { trend: opts.trend } : {}),
    ...(opts.research ? { research: opts.research } : {}),
  }
```

Because these are partial overrides on top of a fake bundle, the `useFakes` guard must still reject a *fully* unspecified real run. Keep the guard, and extend its message to mention that individual provider overrides are allowed alongside `useFakes`.

- [ ] **Step 4: Add the opt-in integration suite**

Create `vitest.integration.config.ts`:

```ts
import path from 'node:path'
import { defineConfig } from 'vitest/config'

const pkg = (name: string) => path.resolve(__dirname, 'packages', name, 'src')

export default defineConfig({
  resolve: {
    alias: {
      '@yt/core': pkg('core'),
      '@yt/db': pkg('db'),
      '@yt/pipeline': pkg('pipeline'),
      '@yt/providers': pkg('providers'),
    },
  },
  test: {
    include: ['test/integration/**/*.integration.test.ts'],
    globalSetup: ['./test/setup/global-db.ts'],
    // A local 8B model takes minutes for six stages.
    testTimeout: 900_000,
    hookTimeout: 60_000,
    environment: 'node',
  },
})
```

Add to `package.json` scripts:

```json
    "test:integration": "vitest run --config vitest.integration.config.ts",
```

Create `test/integration/llm-block.integration.test.ts`:

```ts
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ScenePlanSchema, ScriptSchema, SECTION_KINDS, SeoSchema, TopicSchema } from '@yt/core'
import { createHttpOllamaClient, OllamaLlmProvider, WikipediaResearchProvider, HttpTrendProvider } from '@yt/providers'
import type { Repositories } from '@yt/db'
import { buildLlmStages, FileArtifactStore, runPaths, runPipeline } from '@yt/pipeline'
import { createTestDb } from '../setup/db'

const HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'
const MODEL = process.env.LLM_MODEL ?? 'qwen3:8b'
const configDir = path.resolve(__dirname, '../../config')

let repos: Repositories
let cleanup: () => Promise<void>
let storageRoot: string

beforeEach(async () => {
  const db = await createTestDb()
  repos = db.repos
  cleanup = db.cleanup
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-int-'))
})
afterEach(async () => {
  await cleanup()
  await fs.rm(storageRoot, { recursive: true, force: true })
})

describe('the LLM block against a real local model', () => {
  it('produces a grounded script, a scene plan and scored SEO from a real topic', async () => {
    const client = createHttpOllamaClient({ host: HOST })
    const llm = new OllamaLlmProvider({ client, model: MODEL, log: (m) => console.log(`  llm: ${m}`) })

    const result = await runPipeline({
      runId: 'run-integration',
      repos,
      configDir,
      storageRoot,
      request: { niche: 'space', videoType: 'shorts' },
      useFakes: true,
      stages: buildLlmStages(),
      llm,
      trend: new HttpTrendProvider({ log: (m) => console.log(`  trend: ${m}`) }),
      research: new WikipediaResearchProvider({ log: (m) => console.log(`  research: ${m}`) }),
      onLog: (e) => console.log(`  [${e.level}] ${e.message}`),
    })

    // A halt is a legitimate outcome (an ungrounded script SHOULD stop the run), so assert on
    // what was produced rather than only on the status.
    console.log(`run finished: ${result.status}${result.reason ? ` — ${result.reason}` : ''}`)

    const artifacts = new FileArtifactStore(runPaths(storageRoot, 'run-integration'))

    const topic = await artifacts.read('topic', TopicSchema)
    expect(topic.title.length).toBeGreaterThan(0)
    expect(topic.angle.length).toBeGreaterThan(10)
    console.log(`topic: ${topic.title} (${topic.total}/40) — ${topic.angle}`)

    const script = await artifacts.read('script', ScriptSchema)
    expect(script.sections.map((s) => s.kind)).toEqual([...SECTION_KINDS])
    const beats = script.sections.flatMap((s) => s.beats)
    expect(beats.every((b) => b.targetSeconds >= 15 && b.targetSeconds <= 30)).toBe(true)
    console.log(`script: ${beats.length} beats, ~${beats.reduce((a, b) => a + b.targetSeconds, 0)}s`)
    console.log(`hook: ${script.sections[0]!.beats[0]!.text}`)

    if (result.status !== 'failed') {
      const scenes = await artifacts.read('scenes', ScenePlanSchema)
      expect(scenes.scenes.length).toBeGreaterThan(0)
      const seo = await artifacts.read('seo', SeoSchema)
      expect(seo.titles).toHaveLength(20)
      expect(seo.titles.some((t) => t.title === seo.chosenTitle)).toBe(true)
      console.log(`chosen title: ${seo.chosenTitle}`)
    }
  })
})
```

- [ ] **Step 5: Run the unit suite**

Run: `pnpm test`
Expected: PASS. The e2e tests now pass explicit stages and providers; if the `useFakes` guard rejects a combination, that is the guard working — switch that call to explicit providers rather than weakening the guard.

- [ ] **Step 6: Run the integration suite against the real model**

Start the server in another terminal: `pnpm ollama:serve`

Run: `pnpm test:integration`

Expected: it completes. Record the FULL console output in your report — the chosen topic and angle, the beat count and total duration, the hook line verbatim, and the chosen title. **This is the deliverable of the whole plan**: the first time this project writes something a person would actually watch. If the model repeatedly fails to produce a schema-valid script, do not relax the schema — report the failure with the provider's error, which includes the raw response, so the prompt can be tuned instead.

- [ ] **Step 7: Run the pipeline as a program**

Run: `pnpm pipeline:run real-1` (with the server running), then `pnpm pipeline:run real-1` again.
Expected: the first run executes the six stages; the second reports all six as already completed. Record both outputs and inspect `storage/videos/real-1/` — report which artifact files exist and paste the first few lines of `script.json`.

- [ ] **Step 8: Commit**

```bash
git add packages/pipeline/src test package.json vitest.integration.config.ts
git commit -m "feat(pipeline): wire the six LLM stages and add an opt-in real-model integration suite"
```

---

## Plan 2 completion checklist

- [ ] `pnpm test` passes with zero models loaded, in seconds
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm check` reports the ollama binary and LLM weights present, and exits 0
- [ ] `pnpm test:integration` produces a real script whose beats are all 15–30 s and whose sections are the eight arc kinds in order
- [ ] `pnpm pipeline:run <id>` twice: the six stages run, then all six are skipped
- [ ] A topic is never selected twice — the dedupe table is checked before the model is asked
- [ ] The fact checker halts a run whose script is not grounded in its research
- [ ] No stage imports a concrete provider; every stage's `requires` matches the canonical map
- [ ] The image model is evicted before the small-model block (Task 1's broker test proves it)

## Deferred from Plan 1, now closed

Task 1 closes the render-eviction gap; Task 2 the missing real clock; Task 3 both the stage-list validation and the retry backoff. The remaining Plan 1 deferrals stay open and are re-listed in `PLAN-2-HANDOFF.md`; the ones most worth folding into Plan 3 are the artifact write atomicity and the stranded-`running` job reaper.
