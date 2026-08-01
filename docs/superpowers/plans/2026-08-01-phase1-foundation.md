# AI YouTube Factory — Plan 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the monorepo, domain schemas, provider interfaces, persistence, and orchestration engine so the full fourteen-stage pipeline runs end-to-end against fake providers in seconds with no AI models loaded.

**Architecture:** A pnpm workspace of TypeScript packages. `@yt/core` holds domain types, Zod schemas, and provider interfaces — no implementations. `@yt/db` wraps Prisma/SQLite behind repositories. `@yt/pipeline` holds the orchestration engine: a ModelBroker that guarantees only one heavy model is memory-resident, a StageRunner that executes ordered stages with retry/resume/pause semantics, and a SQLite-backed job worker. `@yt/providers` holds fake adapters only in this plan; real adapters arrive in Plans 2–4. Stages themselves are injected, so the engine is tested against fake stages and never knows stage internals.

**Tech Stack:** Node 26, TypeScript (CommonJS output), pnpm workspaces, Zod, Prisma + SQLite, Vitest, tsx.

**Source spec:** `docs/superpowers/specs/2026-08-01-ai-youtube-factory-mvp-design.md`

## Global Constraints

- **Zero paid services.** No cloud provider, no hosted API, no service requiring billing.
- **All downloads stay in-repo.** Model weights to `models/`, binaries to `bin/`. Redirected via `OLLAMA_MODELS` and `HF_HOME`. Deleting the repo must fully revert the machine.
- **Only pre-existing system tools may be assumed:** `ffmpeg`, `whisper-cli`, `node`, `python3`.
- **16 GB unified memory.** An 8B LLM (~6 GB), SDXL (~8 GB), and headless Chromium (~3 GB) cannot be co-resident. Every heavy model is acquired through the ModelBroker. Never hold two.
- **Stage order is grouped by model requirement**, exactly: `topic-scout, researcher, script-writer, fact-checker, scene-planner, seo, illustrator, thumbnailer, narrator, captioner, clip-gate, editor, quality-gate, publisher`. This ordering yields two model swaps per run; do not reorder.
- **Every external capability sits behind an interface** in `@yt/core`. No stage may import a concrete provider. A stage cannot tell which model it is using.
- **Every stage writes artifacts to disk and records completion in SQLite**, so a killed run resumes from its last completed stage.
- **No `Date.now()` or `new Date()` inside engine code.** Inject `Clock`. Tests must be deterministic. This binds TypeScript engine and stage code only; Prisma's database-side `@default(now())` and `@updatedAt` on audit columns are permitted, since no test asserts on them and no logic reads them.
- **Story structure:** exactly 8 sections in order — `hook, question, conflict, curiosity, reveal, twist, conclusion, cta`. Beats within sections are 15–30 seconds each, schema-enforced.
- **Format presets:** `shorts` = 1080×1920, 45–60 s, 8–12 scenes, ~10 images, 2 clips. `long` = 1920×1080, 480–600 s, 60–90 scenes, ~70 images, 6 clips. Both H.264 @ 30 fps.
- **Config precedence:** per-run request → `app.json` → niche config → built-in default. Leftmost present value wins.
- **Metadata limits:** title ≤ 100 chars, description ≤ 5000 chars, tags ≤ 500 chars total.
- **Fact-check threshold:** halt the run if more than 15% of claims fail.
- **Retries:** LLM stages 3, network stages 3, render 1, all others 1.
- **Clip defaults:** enabled, source `manual`, budget 2/6, placement `hook, reveal, twist`, max 8 s, strip audio, fallback `image`, wait timeout 72 h.
- **Test suite runs with zero models loaded** and must complete in seconds.

---

## File Structure

Files created by this plan, and what each is responsible for:

**Root**
- `pnpm-workspace.yaml` — workspace globs
- `package.json` — root scripts (`test`, `typecheck`, `doctor`, `pipeline:run`)
- `tsconfig.base.json` — shared compiler options and path aliases
- `vitest.config.ts` — single test config with workspace aliases and DB global setup
- `.env.example` — documents `DATABASE_URL`, `STORAGE_ROOT`, `OLLAMA_MODELS`, `HF_HOME`

**`packages/core`** — domain vocabulary, zero dependencies on other packages
- `src/domain.ts` — stage names, run statuses, model requirements, video formats, stage→retry-kind map
- `src/presets.ts` — `FORMAT_PRESETS`
- `src/schemas/config.ts` — `AppConfigSchema`, `NicheConfigSchema`, `ClipsConfigSchema`
- `src/schemas/content.ts` — `ScriptSchema`, `ScenePlanSchema`, `SeoSchema`, `ResearchSchema`, `FactCheckSchema`
- `src/schemas/video-spec.ts` — `VideoSpecSchema`
- `src/providers.ts` — the seven provider interfaces and their DI tokens
- `src/stage.ts` — `Stage`, `StageOutcome`, `RunContext`, `RunLogger`, `Clock`
- `src/index.ts` — public surface

**`packages/db`** — persistence, the only package importing Prisma
- `prisma/schema.prisma` — `Run`, `StageRun`, `Topic`, `Asset`, `TitleCandidate`, `ClipRequest`, `Job`
- `src/client.ts` — client construction from `DATABASE_URL`
- `src/repositories/run.repository.ts` — run + stage-run lifecycle
- `src/repositories/topic.repository.ts` — permanent topic dedupe
- `src/repositories/job.repository.ts` — queue claim/complete/fail
- `src/repositories/clip.repository.ts` — clip requests
- `src/index.ts` — `Repositories` bundle

**`packages/pipeline`** — orchestration engine, no stage implementations
- `src/model-broker.ts` — single-resident-model mutex
- `src/retry.ts` — retry policy from stage kind
- `src/stage-runner.ts` — ordered execution, persistence, resume, pause
- `src/job-worker.ts` — SQLite-backed worker, concurrency 1
- `src/config/resolve.ts` — precedence merge
- `src/config/load.ts` — reads `config/app.json` and `config/niches/*.json`
- `src/storage/paths.ts` — per-run directory layout
- `src/storage/artifacts.ts` — schema-validated artifact read/write
- `src/logger.ts` — `RunLogger` writing to DB and emitting events for SSE
- `src/doctor.ts` — dependency checks
- `src/cli.ts` — `pipeline:run` and `doctor` entrypoints

**`packages/providers`** — adapters; fakes only in this plan
- `src/fake/*.ts` — one fake per provider interface
- `src/index.ts`

**`config`**
- `app.json` — global defaults
- `niches/{tech,ai,programming,space,science,education,knowledge,politics}.json`

**`test`**
- `test/setup/global-db.ts` — builds a migrated SQLite template once
- `test/setup/db.ts` — per-test database copies
- `test/fixtures/stages.ts` — fake stages for engine tests

---

### Task 1: Monorepo scaffolding and test harness

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `.env.example`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`
- Test: `packages/core/src/smoke.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: workspace layout; the alias `@yt/core` → `packages/core/src`; `pnpm test` and `pnpm typecheck` scripts that later tasks rely on.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { PACKAGE_NAME } from '@yt/core'

describe('workspace harness', () => {
  it('resolves the @yt/core alias', () => {
    expect(PACKAGE_NAME).toBe('@yt/core')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/smoke.test.ts`
Expected: FAIL — vitest is not installed yet, so the command errors with "vitest: command not found" or a missing-config error.

- [ ] **Step 3: Create the workspace files**

`pnpm-workspace.yaml`:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

`package.json`:

```json
{
  "name": "youtube-videos-maker",
  "private": true,
  "type": "commonjs",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.base.json --noEmit",
    "doctor": "tsx packages/pipeline/src/cli.ts doctor",
    "pipeline:run": "tsx packages/pipeline/src/cli.ts run"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "prisma": "^5.22.0",
    "tsx": "^4.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

`prisma` is a root devDependency, not only a `@yt/db` one, because the Vitest global setup
invokes `pnpm exec prisma` from the repository root. pnpm does not hoist a workspace package's
binaries to the root `node_modules/.bin`, so a `@yt/db`-only dependency would not be found
there. `@types/node` tracks the Node 26 runtime, since Task 13 uses `fs.statfs`.

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "commonjs",
    "moduleResolution": "node",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "forceConsistentCasingInFileNames": true,
    "baseUrl": ".",
    "paths": {
      "@yt/core": ["packages/core/src"],
      "@yt/core/*": ["packages/core/src/*"],
      "@yt/db": ["packages/db/src"],
      "@yt/pipeline": ["packages/pipeline/src"],
      "@yt/providers": ["packages/providers/src"]
    }
  },
  "include": ["packages/*/src/**/*.ts", "test/**/*.ts", "vitest.config.ts"]
}
```

`vitest.config.ts`:

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
    include: ['packages/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
})
```

`.env.example`:

```bash
# SQLite database location
DATABASE_URL="file:../../storage/factory.db"
# Per-run asset root
STORAGE_ROOT="./storage"
# Keep every model download inside the repo
OLLAMA_MODELS="./models/ollama"
HF_HOME="./models/hf"
```

`packages/core/package.json`:

```json
{
  "name": "@yt/core",
  "version": "0.0.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": { "zod": "^3.23.0" }
}
```

`packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"]
}
```

`packages/core/src/index.ts`:

```ts
export const PACKAGE_NAME = '@yt/core'
```

- [ ] **Step 4: Install dependencies**

Run: `pnpm install`
Expected: lockfile created, `node_modules` populated, no errors.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test`
Expected: PASS — 1 test.

- [ ] **Step 6: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: no output, exit code 0.

- [ ] **Step 7: Commit**

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json vitest.config.ts .env.example packages/core
git commit -m "chore: scaffold pnpm workspace with vitest harness"
```

---

### Task 2: Domain vocabulary and format presets

**Files:**
- Create: `packages/core/src/domain.ts`, `packages/core/src/presets.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/domain.test.ts`, `packages/core/src/presets.test.ts`

**Interfaces:**
- Consumes: `@yt/core` package from Task 1
- Produces:
  - `STAGE_NAMES: readonly StageName[]` — the 14 names in canonical execution order
  - `type StageName`, `type ModelRequirement = 'llm' | 'sd' | 'none'`
  - `RUN_STATUSES`, `type RunStatus = 'queued' | 'running' | 'awaiting_clips' | 'awaiting_review' | 'failed' | 'published'`
  - `SECTION_KINDS`, `type SectionKind`
  - `CAMERA_MOVES`, `type CameraMove`
  - `type VideoFormat = 'shorts' | 'long'`
  - `STAGE_REQUIREMENTS: Record<StageName, ModelRequirement>`
  - `STAGE_RETRY_KIND: Record<StageName, 'llm' | 'network' | 'render' | 'local'>`
  - `FORMAT_PRESETS: Record<VideoFormat, FormatPreset>` and `interface FormatPreset`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/domain.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  STAGE_NAMES,
  STAGE_REQUIREMENTS,
  STAGE_RETRY_KIND,
  SECTION_KINDS,
  RUN_STATUSES,
} from '@yt/core'

describe('stage vocabulary', () => {
  it('declares fourteen stages in the spec order', () => {
    expect(STAGE_NAMES).toEqual([
      'topic-scout',
      'researcher',
      'script-writer',
      'fact-checker',
      'scene-planner',
      'seo',
      'illustrator',
      'thumbnailer',
      'narrator',
      'captioner',
      'clip-gate',
      'editor',
      'quality-gate',
      'publisher',
    ])
  })

  it('groups model requirements so there are exactly two model swaps', () => {
    const sequence = STAGE_NAMES.map((n) => STAGE_REQUIREMENTS[n])
    const compacted = sequence.filter((req, i) => req !== sequence[i - 1])
    expect(compacted).toEqual(['llm', 'sd', 'none'])
  })

  it('gives every stage a retry kind', () => {
    for (const name of STAGE_NAMES) {
      expect(STAGE_RETRY_KIND[name]).toBeDefined()
    }
  })

  it('declares the eight story sections in arc order', () => {
    expect(SECTION_KINDS).toEqual([
      'hook',
      'question',
      'conflict',
      'curiosity',
      'reveal',
      'twist',
      'conclusion',
      'cta',
    ])
  })

  it('includes a paused status for the clip gate', () => {
    expect(RUN_STATUSES).toContain('awaiting_clips')
  })
})
```

Create `packages/core/src/presets.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { FORMAT_PRESETS } from '@yt/core'

describe('format presets', () => {
  it('defines vertical shorts', () => {
    expect(FORMAT_PRESETS.shorts).toMatchObject({
      width: 1080,
      height: 1920,
      fps: 30,
      minDurationSec: 45,
      maxDurationSec: 60,
      minScenes: 8,
      maxScenes: 12,
      imageBudget: 10,
      clipBudget: 2,
    })
  })

  it('defines horizontal long-form', () => {
    expect(FORMAT_PRESETS.long).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 30,
      minDurationSec: 480,
      maxDurationSec: 600,
      minScenes: 60,
      maxScenes: 90,
      imageBudget: 70,
      clipBudget: 6,
    })
  })

  it('keeps the image budget consistent with one image per 8-10 seconds', () => {
    for (const preset of Object.values(FORMAT_PRESETS)) {
      const perImageSeconds = preset.maxDurationSec / preset.imageBudget
      expect(perImageSeconds).toBeGreaterThanOrEqual(6)
      expect(perImageSeconds).toBeLessThanOrEqual(10)
    }
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/domain.test.ts packages/core/src/presets.test.ts`
Expected: FAIL — `STAGE_NAMES` and `FORMAT_PRESETS` are not exported from `@yt/core`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/domain.ts`:

```ts
export const STAGE_NAMES = [
  'topic-scout',
  'researcher',
  'script-writer',
  'fact-checker',
  'scene-planner',
  'seo',
  'illustrator',
  'thumbnailer',
  'narrator',
  'captioner',
  'clip-gate',
  'editor',
  'quality-gate',
  'publisher',
] as const

export type StageName = (typeof STAGE_NAMES)[number]

export type ModelRequirement = 'llm' | 'sd' | 'none'

/**
 * Grouped so the ModelBroker performs two evictions per run rather than twelve.
 * See spec section 2. Do not reorder.
 */
export const STAGE_REQUIREMENTS: Record<StageName, ModelRequirement> = {
  'topic-scout': 'llm',
  researcher: 'llm',
  'script-writer': 'llm',
  'fact-checker': 'llm',
  'scene-planner': 'llm',
  seo: 'llm',
  illustrator: 'sd',
  thumbnailer: 'sd',
  narrator: 'none',
  captioner: 'none',
  'clip-gate': 'none',
  editor: 'none',
  'quality-gate': 'none',
  publisher: 'none',
}

export const STAGE_RETRY_KIND: Record<StageName, 'llm' | 'network' | 'render' | 'local'> = {
  'topic-scout': 'network',
  researcher: 'network',
  'script-writer': 'llm',
  'fact-checker': 'llm',
  'scene-planner': 'llm',
  seo: 'llm',
  illustrator: 'local',
  thumbnailer: 'local',
  narrator: 'local',
  captioner: 'local',
  'clip-gate': 'local',
  editor: 'render',
  'quality-gate': 'local',
  publisher: 'network',
}

export const RUN_STATUSES = [
  'queued',
  'running',
  'awaiting_clips',
  'awaiting_review',
  'failed',
  'published',
] as const

export type RunStatus = (typeof RUN_STATUSES)[number]

export const SECTION_KINDS = [
  'hook',
  'question',
  'conflict',
  'curiosity',
  'reveal',
  'twist',
  'conclusion',
  'cta',
] as const

export type SectionKind = (typeof SECTION_KINDS)[number]

export const CAMERA_MOVES = [
  'zoom-in',
  'zoom-out',
  'pan-left',
  'pan-right',
  'parallax',
  'still',
] as const

export type CameraMove = (typeof CAMERA_MOVES)[number]

export const VIDEO_FORMATS = ['shorts', 'long'] as const

export type VideoFormat = (typeof VIDEO_FORMATS)[number]
```

Create `packages/core/src/presets.ts`:

```ts
import type { VideoFormat } from './domain'

export interface FormatPreset {
  format: VideoFormat
  width: number
  height: number
  fps: number
  minDurationSec: number
  maxDurationSec: number
  minScenes: number
  maxScenes: number
  /** Generated images per video. Roughly one per 8-10 seconds of narration. */
  imageBudget: number
  /** Human-supplied Veo clips per video. Scarce; spent on hero sections only. */
  clipBudget: number
}

export const FORMAT_PRESETS: Record<VideoFormat, FormatPreset> = {
  shorts: {
    format: 'shorts',
    width: 1080,
    height: 1920,
    fps: 30,
    minDurationSec: 45,
    maxDurationSec: 60,
    minScenes: 8,
    maxScenes: 12,
    imageBudget: 10,
    clipBudget: 2,
  },
  long: {
    format: 'long',
    width: 1920,
    height: 1080,
    fps: 30,
    minDurationSec: 480,
    maxDurationSec: 600,
    minScenes: 60,
    maxScenes: 90,
    imageBudget: 70,
    clipBudget: 6,
  },
}
```

Replace `packages/core/src/index.ts`:

```ts
export const PACKAGE_NAME = '@yt/core'

export * from './domain'
export * from './presets'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src
git commit -m "feat(core): add stage vocabulary and format presets"
```

---

### Task 3: Content schemas

The schemas are where the spec's creative rules become machine-enforced: exactly eight sections in arc order, beats of 15–30 seconds, twenty scored titles, and YouTube's metadata limits.

**Files:**
- Create: `packages/core/src/schemas/content.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/schemas/content.test.ts`

**Interfaces:**
- Consumes: `SECTION_KINDS`, `CAMERA_MOVES` from Task 2
- Produces:
  - `ResearchSchema` / `type Research` — `{ topicTitle, facts: {text, sourceUrl}[] }`
  - `ScriptSchema` / `type Script` — `{ topicTitle, sections: {kind, beats: {id, text, targetSeconds}[]}[] }`
  - `FactCheckSchema` / `type FactCheck` — `{ claims: {text, verdict, sourceUrl?}[], failureRatio }`
  - `ScenePlanSchema` / `type ScenePlan`, `type Scene`, `type SceneVisual`
  - `SeoSchema` / `type Seo`, `type TitleCandidate`
  - `MAX_TITLE_CHARS = 100`, `MAX_DESCRIPTION_CHARS = 5000`, `MAX_TAGS_CHARS = 500`, `MAX_FAILURE_RATIO = 0.15`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/schemas/content.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ScriptSchema, ScenePlanSchema, SeoSchema, SECTION_KINDS } from '@yt/core'

const beat = (seconds: number) => ({ id: 'b1', text: 'Narration line.', targetSeconds: seconds })

const script = (overrides: Record<string, unknown> = {}) => ({
  topicTitle: 'Why Venus spins backwards',
  sections: SECTION_KINDS.map((kind) => ({ kind, beats: [beat(20)] })),
  ...overrides,
})

describe('ScriptSchema', () => {
  it('accepts the eight-section arc', () => {
    expect(ScriptSchema.safeParse(script()).success).toBe(true)
  })

  it('rejects a beat shorter than fifteen seconds', () => {
    const bad = script({
      sections: SECTION_KINDS.map((kind) => ({ kind, beats: [beat(kind === 'hook' ? 9 : 20)] })),
    })
    expect(ScriptSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a beat longer than thirty seconds', () => {
    const bad = script({
      sections: SECTION_KINDS.map((kind) => ({ kind, beats: [beat(kind === 'hook' ? 45 : 20)] })),
    })
    expect(ScriptSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a missing section', () => {
    const bad = script({
      sections: SECTION_KINDS.slice(0, 7).map((kind) => ({ kind, beats: [beat(20)] })),
    })
    expect(ScriptSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects sections out of arc order', () => {
    const reordered = [...SECTION_KINDS].reverse()
    const bad = script({ sections: reordered.map((kind) => ({ kind, beats: [beat(20)] })) })
    expect(ScriptSchema.safeParse(bad).success).toBe(false)
  })

  it('allows many beats per section so long-form is expressible', () => {
    const long = script({
      sections: SECTION_KINDS.map((kind) => ({
        kind,
        beats: Array.from({ length: 3 }, (_, i) => ({ ...beat(25), id: `${kind}-${i}` })),
      })),
    })
    const parsed = ScriptSchema.safeParse(long)
    expect(parsed.success).toBe(true)
    const total = long.sections.flatMap((s) => s.beats).reduce((a, b) => a + b.targetSeconds, 0)
    expect(total).toBeGreaterThan(480)
  })
})

describe('ScenePlanSchema', () => {
  const scene = (visual: unknown) => ({
    id: 's1',
    beatId: 'b1',
    text: 'Narration line.',
    visual,
    camera: 'zoom-in',
  })

  it('accepts an sd-image scene with a prompt', () => {
    const result = ScenePlanSchema.safeParse({
      scenes: [scene({ kind: 'sd-image', prompt: 'a cracked desert under a red sky' })],
    })
    expect(result.success).toBe(true)
  })

  it('requires a veo-clip scene to carry an image fallback', () => {
    const missingFallback = ScenePlanSchema.safeParse({
      scenes: [scene({ kind: 'veo-clip', prompt: 'dust storm rolling in', referenceSceneId: 's1' })],
    })
    expect(missingFallback.success).toBe(false)

    const withFallback = ScenePlanSchema.safeParse({
      scenes: [
        scene({
          kind: 'veo-clip',
          prompt: 'dust storm rolling in',
          referenceSceneId: 's1',
          fallbackPrompt: 'a dust storm over a desert plain',
        }),
      ],
    })
    expect(withFallback.success).toBe(true)
  })

  it('rejects an unknown camera move', () => {
    const result = ScenePlanSchema.safeParse({
      scenes: [{ ...scene({ kind: 'sd-image', prompt: 'x' }), camera: 'barrel-roll' }],
    })
    expect(result.success).toBe(false)
  })
})

describe('SeoSchema', () => {
  const titles = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      title: `Title number ${i}`,
      scores: { curiosity: 7, searchIntent: 6, simplicity: 8, ctr: 7 },
      total: 28,
    }))

  const seo = (overrides: Record<string, unknown> = {}) => ({
    titles: titles(20),
    chosenTitle: 'Title number 0',
    description: 'A description.',
    tags: ['space', 'venus'],
    hashtags: ['#space'],
    ...overrides,
  })

  it('accepts twenty scored titles', () => {
    expect(SeoSchema.safeParse(seo()).success).toBe(true)
  })

  it('rejects fewer than twenty titles', () => {
    expect(SeoSchema.safeParse(seo({ titles: titles(5) })).success).toBe(false)
  })

  it('rejects a chosen title absent from the candidates', () => {
    expect(SeoSchema.safeParse(seo({ chosenTitle: 'Not in the list' })).success).toBe(false)
  })

  it('rejects a title over one hundred characters', () => {
    const overlong = titles(20)
    overlong[0] = { ...overlong[0]!, title: 'x'.repeat(101) }
    expect(SeoSchema.safeParse(seo({ titles: overlong, chosenTitle: 'x'.repeat(101) })).success).toBe(
      false,
    )
  })

  it('rejects tags exceeding five hundred characters in total', () => {
    const fat = Array.from({ length: 30 }, () => 'x'.repeat(20))
    expect(SeoSchema.safeParse(seo({ tags: fat })).success).toBe(false)
  })

  it('rejects a description over five thousand characters', () => {
    expect(SeoSchema.safeParse(seo({ description: 'x'.repeat(5001) })).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/schemas/content.test.ts`
Expected: FAIL — `ScriptSchema` is not exported from `@yt/core`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/schemas/content.ts`:

```ts
import { z } from 'zod'
import { CAMERA_MOVES, SECTION_KINDS } from '../domain'

export const MAX_TITLE_CHARS = 100
export const MAX_DESCRIPTION_CHARS = 5000
export const MAX_TAGS_CHARS = 500
export const MAX_FAILURE_RATIO = 0.15

export const ResearchSchema = z.object({
  topicTitle: z.string().min(1),
  facts: z
    .array(
      z.object({
        text: z.string().min(1),
        sourceUrl: z.string().url(),
      }),
    )
    .min(1),
})
export type Research = z.infer<typeof ResearchSchema>

export const BeatSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  /** Engagement pacing rule from the spec: something new every 15-30 seconds. */
  targetSeconds: z.number().min(15).max(30),
})
export type Beat = z.infer<typeof BeatSchema>

export const SectionSchema = z.object({
  kind: z.enum(SECTION_KINDS),
  beats: z.array(BeatSchema).min(1),
})
export type Section = z.infer<typeof SectionSchema>

export const ScriptSchema = z
  .object({
    topicTitle: z.string().min(1),
    sections: z.array(SectionSchema).length(SECTION_KINDS.length),
  })
  .superRefine((value, ctx) => {
    const kinds = value.sections.map((s) => s.kind)
    const expected = [...SECTION_KINDS]
    if (kinds.join('|') !== expected.join('|')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sections'],
        message: `sections must be exactly ${expected.join(', ')} in that order`,
      })
    }
  })
export type Script = z.infer<typeof ScriptSchema>

export const SceneVisualSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sd-image'), prompt: z.string().min(1) }),
  z.object({
    kind: z.literal('motion-graphic'),
    variant: z.enum(['timeline', 'map', 'stat', 'quote', 'list']),
    payload: z.record(z.unknown()),
  }),
  z.object({ kind: z.literal('reuse'), sceneId: z.string().min(1) }),
  z.object({
    kind: z.literal('veo-clip'),
    prompt: z.string().min(1),
    /** Scene whose SDXL image is handed to Veo as the first frame, for style coherence. */
    referenceSceneId: z.string().min(1),
    /** Mandatory: a missing clip must degrade to an image, never block the run. */
    fallbackPrompt: z.string().min(1),
  }),
])
export type SceneVisual = z.infer<typeof SceneVisualSchema>

export const SceneSchema = z.object({
  id: z.string().min(1),
  beatId: z.string().min(1),
  text: z.string().min(1),
  visual: SceneVisualSchema,
  camera: z.enum(CAMERA_MOVES),
  /** Populated by the narrator stage once audio has been measured. */
  durationSec: z.number().positive().optional(),
})
export type Scene = z.infer<typeof SceneSchema>

export const ScenePlanSchema = z.object({
  scenes: z.array(SceneSchema).min(1),
})
export type ScenePlan = z.infer<typeof ScenePlanSchema>

export const FactCheckSchema = z.object({
  claims: z
    .array(
      z.object({
        text: z.string().min(1),
        verdict: z.enum(['supported', 'unsupported', 'contradicted']),
        sourceUrl: z.string().url().optional(),
      }),
    )
    .min(1),
  failureRatio: z.number().min(0).max(1),
})
export type FactCheck = z.infer<typeof FactCheckSchema>

export const TitleCandidateSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_CHARS),
  scores: z.object({
    curiosity: z.number().min(0).max(10),
    searchIntent: z.number().min(0).max(10),
    simplicity: z.number().min(0).max(10),
    ctr: z.number().min(0).max(10),
  }),
  total: z.number().min(0).max(40),
})
export type TitleCandidate = z.infer<typeof TitleCandidateSchema>

export const SeoSchema = z
  .object({
    titles: z.array(TitleCandidateSchema).length(20),
    chosenTitle: z.string().min(1).max(MAX_TITLE_CHARS),
    description: z.string().max(MAX_DESCRIPTION_CHARS),
    tags: z.array(z.string().min(1)),
    hashtags: z.array(z.string().min(1)),
  })
  .superRefine((value, ctx) => {
    if (!value.titles.some((t) => t.title === value.chosenTitle)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['chosenTitle'],
        message: 'chosenTitle must be one of the generated candidates',
      })
    }
    const tagChars = value.tags.join(',').length
    if (tagChars > MAX_TAGS_CHARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tags'],
        message: `tags must total at most ${MAX_TAGS_CHARS} characters, got ${tagChars}`,
      })
    }
  })
export type Seo = z.infer<typeof SeoSchema>
```

Append to `packages/core/src/index.ts`:

```ts
export * from './schemas/content'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — 15 new tests in `content.test.ts` (6 script, 3 scene plan, 6 SEO); whole suite green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src
git commit -m "feat(core): add content schemas enforcing arc, beat pacing and metadata limits"
```

---

### Task 4: Config schemas and the eight niche files

**Files:**
- Create: `packages/core/src/schemas/config.ts`
- Create: `config/app.json`
- Create: `config/niches/tech.json`, `ai.json`, `programming.json`, `space.json`, `science.json`, `education.json`, `knowledge.json`, `politics.json`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/schemas/config.test.ts`, `packages/core/src/schemas/niche-files.test.ts`

**Interfaces:**
- Consumes: `SECTION_KINDS`, `VIDEO_FORMATS` from Task 2
- Produces:
  - `AppConfigSchema` / `type AppConfig`
  - `NicheConfigSchema` / `type NicheConfig`
  - `ClipsConfigSchema` / `type ClipsConfig`
  - `TREND_SOURCES` / `type TrendSource` — `'wikipedia-top' | 'hackernews' | 'arxiv' | 'reddit' | 'google-trends'`
  - `DEFAULT_APP_CONFIG: AppConfig` — the built-in default layer of the precedence chain

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/schemas/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { AppConfigSchema, NicheConfigSchema, DEFAULT_APP_CONFIG } from '@yt/core'

describe('AppConfigSchema', () => {
  it('accepts the default config', () => {
    expect(AppConfigSchema.safeParse(DEFAULT_APP_CONFIG).success).toBe(true)
  })

  it('defaults autoPublish to false so nothing publishes unreviewed', () => {
    expect(DEFAULT_APP_CONFIG.autoPublish).toBe(false)
  })

  it('defaults the clip gate to manual with a 72 hour timeout', () => {
    expect(DEFAULT_APP_CONFIG.clips).toMatchObject({
      enabled: true,
      source: 'manual',
      maxSeconds: 8,
      stripAudio: true,
      fallback: 'image',
      waitTimeoutHours: 72,
    })
  })

  it('rejects an unknown video type', () => {
    const bad = { ...DEFAULT_APP_CONFIG, videoType: 'square' }
    expect(AppConfigSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a clip placement that is not a story section', () => {
    const bad = {
      ...DEFAULT_APP_CONFIG,
      clips: { ...DEFAULT_APP_CONFIG.clips, placement: ['outro'] },
    }
    expect(AppConfigSchema.safeParse(bad).success).toBe(false)
  })
})

describe('NicheConfigSchema', () => {
  const niche = {
    id: 'space',
    label: 'Space',
    promptGuidance: 'Explain one cosmic phenomenon through a single concrete object.',
    voice: 'male',
    styleSuffix: 'cinematic astrophotography, deep blacks, volumetric light',
    music: 'ambient-drone',
    trendSources: ['wikipedia-top', 'arxiv'],
    seoRules: 'Lead with the object, not the concept.',
    monetizationRisk: 'low',
  }

  it('accepts a well-formed niche', () => {
    expect(NicheConfigSchema.safeParse(niche).success).toBe(true)
  })

  it('rejects an unknown trend source', () => {
    expect(NicheConfigSchema.safeParse({ ...niche, trendSources: ['tiktok'] }).success).toBe(false)
  })

  it('requires a monetization risk rating', () => {
    const { monetizationRisk, ...withoutRisk } = niche
    expect(NicheConfigSchema.safeParse(withoutRisk).success).toBe(false)
  })
})
```

Create `packages/core/src/schemas/niche-files.test.ts`:

```ts
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AppConfigSchema, NicheConfigSchema } from '@yt/core'

const configDir = path.resolve(__dirname, '../../../../config')
const nicheDir = path.join(configDir, 'niches')

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'))

describe('shipped config files', () => {
  it('app.json satisfies the schema', () => {
    const parsed = AppConfigSchema.safeParse(readJson(path.join(configDir, 'app.json')))
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
  })

  it('ships the eight niches named in the spec', () => {
    const files = fs.readdirSync(nicheDir).filter((f) => f.endsWith('.json')).sort()
    expect(files).toEqual([
      'ai.json',
      'education.json',
      'knowledge.json',
      'politics.json',
      'programming.json',
      'science.json',
      'space.json',
      'tech.json',
    ])
  })

  it('every niche file satisfies the schema and matches its filename', () => {
    for (const file of fs.readdirSync(nicheDir).filter((f) => f.endsWith('.json'))) {
      const parsed = NicheConfigSchema.safeParse(readJson(path.join(nicheDir, file)))
      expect(parsed.success, `${file}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true)
      expect(parsed.success && parsed.data.id).toBe(path.basename(file, '.json'))
    }
  })

  it('flags politics as high monetization risk with explainer-only framing', () => {
    const politics = NicheConfigSchema.parse(readJson(path.join(nicheDir, 'politics.json')))
    expect(politics.monetizationRisk).toBe('high')
    expect(politics.promptGuidance.toLowerCase()).toContain('explainer')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/schemas`
Expected: FAIL — `AppConfigSchema` is not exported, and `config/` does not exist.

- [ ] **Step 3: Write the schemas**

Create `packages/core/src/schemas/config.ts`:

```ts
import { z } from 'zod'
import { SECTION_KINDS, VIDEO_FORMATS } from '../domain'

export const TREND_SOURCES = [
  'wikipedia-top',
  'hackernews',
  'arxiv',
  'reddit',
  'google-trends',
] as const
export type TrendSource = (typeof TREND_SOURCES)[number]

export const ClipsConfigSchema = z.object({
  enabled: z.boolean(),
  /** 'manual' = human generates under their Google AI Pro plan. 'api' needs billing. */
  source: z.enum(['manual', 'api']),
  budget: z.object({
    shorts: z.number().int().nonnegative(),
    long: z.number().int().nonnegative(),
  }),
  /** Clips are scarce, so they are spent only on these hero sections. */
  placement: z.array(z.enum(SECTION_KINDS)).min(1),
  maxSeconds: z.number().positive(),
  /** Veo generates native audio, which would collide with the narration. */
  stripAudio: z.boolean(),
  fallback: z.literal('image'),
  waitTimeoutHours: z.number().positive(),
})
export type ClipsConfig = z.infer<typeof ClipsConfigSchema>

export const BrandCornerSchema = z.object({
  enabled: z.boolean(),
  position: z.enum(['bottom-right', 'bottom-left', 'top-right', 'top-left']),
})
export type BrandCorner = z.infer<typeof BrandCornerSchema>

export const RetryConfigSchema = z.object({
  llm: z.number().int().min(1),
  network: z.number().int().min(1),
  render: z.number().int().min(1),
  local: z.number().int().min(1),
})
export type RetryConfig = z.infer<typeof RetryConfigSchema>

export const AppConfigSchema = z.object({
  niche: z.string().min(1),
  language: z.string().min(1),
  videoType: z.enum(VIDEO_FORMATS),
  /** Target minutes for long-form; ignored for shorts, which use the preset window. */
  duration: z.number().positive(),
  voice: z.string().min(1),
  /** Optional override; when absent the format preset decides. */
  resolution: z.string().regex(/^\d+x\d+$/).optional(),
  upload: z.boolean(),
  captions: z.boolean(),
  thumbnail: z.boolean(),
  autoPublish: z.boolean(),
  clips: ClipsConfigSchema,
  brandCorner: BrandCornerSchema,
  retries: RetryConfigSchema,
})
export type AppConfig = z.infer<typeof AppConfigSchema>

export const NicheConfigSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  promptGuidance: z.string().min(1),
  voice: z.string().min(1),
  /** Appended to every SD prompt so a niche has one coherent look. */
  styleSuffix: z.string().min(1),
  music: z.string().min(1),
  trendSources: z.array(z.enum(TREND_SOURCES)).min(1),
  seoRules: z.string().min(1),
  monetizationRisk: z.enum(['low', 'medium', 'high']),
})
export type NicheConfig = z.infer<typeof NicheConfigSchema>

export const DEFAULT_APP_CONFIG: AppConfig = {
  niche: 'space',
  language: 'English',
  videoType: 'long',
  duration: 8,
  voice: 'male',
  upload: true,
  captions: true,
  thumbnail: true,
  autoPublish: false,
  clips: {
    enabled: true,
    source: 'manual',
    budget: { shorts: 2, long: 6 },
    placement: ['hook', 'reveal', 'twist'],
    maxSeconds: 8,
    stripAudio: true,
    fallback: 'image',
    waitTimeoutHours: 72,
  },
  brandCorner: { enabled: true, position: 'bottom-right' },
  retries: { llm: 3, network: 3, render: 1, local: 1 },
}
```

Append to `packages/core/src/index.ts`:

```ts
export * from './schemas/config'
```

- [ ] **Step 4: Write `config/app.json`**

```json
{
  "niche": "space",
  "language": "English",
  "videoType": "long",
  "duration": 8,
  "voice": "male",
  "upload": true,
  "captions": true,
  "thumbnail": true,
  "autoPublish": false,
  "clips": {
    "enabled": true,
    "source": "manual",
    "budget": { "shorts": 2, "long": 6 },
    "placement": ["hook", "reveal", "twist"],
    "maxSeconds": 8,
    "stripAudio": true,
    "fallback": "image",
    "waitTimeoutHours": 72
  },
  "brandCorner": { "enabled": true, "position": "bottom-right" },
  "retries": { "llm": 3, "network": 3, "render": 1, "local": 1 }
}
```

- [ ] **Step 5: Write the eight niche files**

`config/niches/tech.json`:

```json
{
  "id": "tech",
  "label": "Technology",
  "promptGuidance": "Explain one piece of technology through the problem it was built to solve. Open on the failure that made it necessary. Avoid release-note recitation; no dated claims that expire within a month.",
  "voice": "male",
  "styleSuffix": "clean industrial product photography, soft studio light, shallow depth of field, muted palette",
  "music": "ambient-pulse",
  "trendSources": ["hackernews", "wikipedia-top"],
  "seoRules": "Name the technology in the first four words. Prefer 'how' and 'why' over 'top N'.",
  "monetizationRisk": "low"
}
```

`config/niches/ai.json`:

```json
{
  "id": "ai",
  "label": "Artificial Intelligence",
  "promptGuidance": "Explain one AI idea using a concrete worked example a viewer can follow without maths. Never anthropomorphise the model. State plainly what is demonstrated versus what is speculated.",
  "voice": "male",
  "styleSuffix": "abstract data visualisation, glowing nodes on deep navy, volumetric light, high contrast",
  "music": "ambient-pulse",
  "trendSources": ["arxiv", "hackernews"],
  "seoRules": "Lead with the capability, not the model name, since model names date quickly.",
  "monetizationRisk": "low"
}
```

`config/niches/programming.json`:

```json
{
  "id": "programming",
  "label": "Programming",
  "promptGuidance": "Take one bug, constraint, or design decision and follow it to its consequence. Show the wrong approach before the right one. Assume the viewer writes code but does not know this domain.",
  "voice": "male",
  "styleSuffix": "dark editor aesthetic, monospaced overlays, teal and amber accents, crisp geometry",
  "music": "lo-fi-minimal",
  "trendSources": ["hackernews", "reddit"],
  "seoRules": "Include the language or tool name. Frame as a problem the viewer has hit.",
  "monetizationRisk": "low"
}
```

`config/niches/space.json`:

```json
{
  "id": "space",
  "label": "Space",
  "promptGuidance": "Explain one cosmic phenomenon through a single concrete object rather than a survey. Use scale comparisons a viewer can picture. Distinguish measurement from inference.",
  "voice": "male",
  "styleSuffix": "cinematic astrophotography, deep blacks, volumetric nebula light, hard rim lighting",
  "music": "ambient-drone",
  "trendSources": ["wikipedia-top", "arxiv"],
  "seoRules": "Lead with the object, not the concept. Numbers in titles earn clicks here.",
  "monetizationRisk": "low"
}
```

`config/niches/science.json`:

```json
{
  "id": "science",
  "label": "Science",
  "promptGuidance": "Build the video around one experiment and what it ruled out. Name the uncertainty rather than smoothing it away. No health, medical, or dietary advice.",
  "voice": "female",
  "styleSuffix": "macro laboratory photography, clean white surfaces, precise focus, cool daylight",
  "music": "ambient-warm",
  "trendSources": ["wikipedia-top", "arxiv"],
  "seoRules": "Pose the question the experiment answered. Avoid absolute claims.",
  "monetizationRisk": "low"
}
```

`config/niches/education.json`:

```json
{
  "id": "education",
  "label": "Education",
  "promptGuidance": "Teach exactly one transferable idea and check understanding twice within the video. Build from a concrete case to the general rule, never the reverse.",
  "voice": "female",
  "styleSuffix": "warm illustrated diagram style, paper texture, limited ochre and slate palette",
  "music": "ambient-warm",
  "trendSources": ["wikipedia-top", "reddit"],
  "seoRules": "Promise one specific skill or idea. Avoid vague 'everything you need to know' framing.",
  "monetizationRisk": "low"
}
```

`config/niches/knowledge.json`:

```json
{
  "id": "knowledge",
  "label": "General Knowledge",
  "promptGuidance": "Start from a fact that contradicts common assumption, then explain why the assumption is widespread. Every surprising claim must be traceable to the research file.",
  "voice": "male",
  "styleSuffix": "editorial documentary photography, natural light, film grain, desaturated palette",
  "music": "ambient-drone",
  "trendSources": ["wikipedia-top", "google-trends"],
  "seoRules": "State the counterintuitive fact plainly. Do not withhold the subject to manufacture mystery.",
  "monetizationRisk": "medium"
}
```

`config/niches/politics.json`:

```json
{
  "id": "politics",
  "label": "Politics and Policy",
  "promptGuidance": "Explainer only: describe how a system, institution, or historical policy works and why it was designed that way. Never advocate a position, endorse or criticise a living politician or party, or discuss an active election. Describe disagreements by explaining what each side wants and why. If the topic cannot be covered without taking sides, abandon it.",
  "voice": "male",
  "styleSuffix": "archival documentary style, muted institutional tones, architectural symmetry, soft overcast light",
  "music": "ambient-neutral",
  "trendSources": ["wikipedia-top"],
  "seoRules": "Frame as a mechanism question such as 'how X works'. No partisan or inflammatory language.",
  "monetizationRisk": "high"
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — 9 new tests (5 config schema, 4 shipped-file checks); whole suite green.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src config
git commit -m "feat(config): add config schemas and eight niche definitions"
```

---

### Task 5: Provider interfaces and the stage contract

This task defines every boundary in the system. Plans 2–4 implement against these signatures, so names and types here are load-bearing — do not rename them later.

**Files:**
- Create: `packages/core/src/providers.ts`, `packages/core/src/stage.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/stage.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–4
- Produces:
  - `Clock` — `{ now(): Date }`
  - `RunLogger` — `{ info, warn, error }`, each `(message: string, meta?: Record<string, unknown>) => void`
  - `ArtifactName` — `'research' | 'script' | 'factcheck' | 'scenes' | 'seo' | 'videoSpec'`
  - `ArtifactStore` — `{ write, read, exists }`
  - `RunPaths` — absolute paths for a run's directories
  - `TopicStore` — `{ hasUsed(key), markUsed(key, title) }`
  - `ClipRequestStore` — `{ create, listForRun, markFulfilled, markSkipped }`
  - `ProviderBundle` — the seven providers
  - `ResolvedConfig` — `AppConfig` plus the resolved niche and preset
  - `RunContext`, `Stage`, `StageOutcome`
  - Seven provider interfaces: `LlmProvider`, `TtsProvider`, `ImageProvider`, `ClipProvider`, `CaptionProvider`, `PublishProvider`, `TrendProvider`
  - `PROVIDER_TOKENS` — DI token constants for NestJS wiring in Plan 4

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/stage.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/stage.test.ts`
Expected: FAIL — `Stage`, `StageOutcome`, and `RunContext` are not exported from `@yt/core`.

- [ ] **Step 3: Write the provider interfaces**

Create `packages/core/src/providers.ts`:

```ts
import type { TrendSource } from './schemas/config'

/** Injected everywhere instead of Date, so engine behaviour is deterministic in tests. */
export interface Clock {
  now(): Date
}

export interface LlmProvider {
  /** Free-form completion. Used for scoring and rewriting. */
  complete(prompt: string, opts?: { temperature?: number; maxTokens?: number }): Promise<string>
  /**
   * Completion constrained to a JSON shape. The adapter is responsible for retrying
   * until the response parses, so stages never see malformed JSON.
   */
  json<T>(prompt: string, schemaName: string, parse: (raw: unknown) => T): Promise<T>
  /** Releases model memory. Called by the ModelBroker, never by a stage. */
  unload(): Promise<void>
}

export interface TtsSpeakRequest {
  text: string
  voice: string
  outPath: string
}

export interface TtsSpeakResult {
  outPath: string
  durationSec: number
}

export interface TtsProvider {
  speak(req: TtsSpeakRequest): Promise<TtsSpeakResult>
}

export interface ImageRequest {
  prompt: string
  width: number
  height: number
  seed: number
  outPath: string
}

export interface ImageProvider {
  generate(req: ImageRequest): Promise<{ outPath: string }>
  unload(): Promise<void>
}

export interface ClipRequestSpec {
  sceneId: string
  prompt: string
  referenceImagePath: string | null
  targetSeconds: number
  aspectRatio: '9:16' | '16:9'
}

export interface ClipResult {
  sceneId: string
  /** Absolute path to the normalised clip, or null when the shot was skipped. */
  path: string | null
}

export interface ClipProvider {
  /**
   * Manual adapter: writes the shot list and returns 'paused' so the human can generate
   * clips under their own subscription. API adapter: generates and returns 'ready'.
   */
  request(specs: ClipRequestSpec[]): Promise<{ status: 'paused' } | { status: 'ready' }>
  /** Called on resume. Validates and normalises whatever arrived. */
  collect(specs: ClipRequestSpec[]): Promise<ClipResult[]>
}

export interface CaptionWord {
  word: string
  startSec: number
  endSec: number
}

export interface CaptionProvider {
  transcribe(audioPath: string): Promise<CaptionWord[]>
}

export interface PublishRequest {
  videoPath: string
  thumbnailPath: string
  captionsPath: string
  title: string
  description: string
  tags: string[]
  privacy: 'private' | 'unlisted' | 'public'
}

export interface PublishProvider {
  publish(req: PublishRequest): Promise<{ videoId: string }>
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

export interface ProviderBundle {
  llm: LlmProvider
  tts: TtsProvider
  image: ImageProvider
  clip: ClipProvider
  caption: CaptionProvider
  publish: PublishProvider
  trend: TrendProvider
}

/** DI tokens for the NestJS wiring introduced in Plan 4. */
export const PROVIDER_TOKENS = {
  llm: 'LLM_PROVIDER',
  tts: 'TTS_PROVIDER',
  image: 'IMAGE_PROVIDER',
  clip: 'CLIP_PROVIDER',
  caption: 'CAPTION_PROVIDER',
  publish: 'PUBLISH_PROVIDER',
  trend: 'TREND_PROVIDER',
  clock: 'CLOCK',
} as const
```

- [ ] **Step 4: Write the stage contract**

Create `packages/core/src/stage.ts`:

```ts
import type { z } from 'zod'
import type { ModelRequirement, StageName } from './domain'
import type { FormatPreset } from './presets'
import type { AppConfig, NicheConfig } from './schemas/config'
import type { Clock, ProviderBundle } from './providers'

export interface RunLogger {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export type ArtifactName = 'research' | 'script' | 'factcheck' | 'scenes' | 'seo' | 'videoSpec'

export interface ArtifactStore {
  write<T>(name: ArtifactName, schema: z.ZodType<T>, data: T): Promise<void>
  read<T>(name: ArtifactName, schema: z.ZodType<T>): Promise<T>
  exists(name: ArtifactName): Promise<boolean>
}

export interface RunPaths {
  root: string
  audio: string
  images: string
  clipsInbox: string
  clipsNormalised: string
  captions: string
  thumbnail: string
  out: string
}

/** Permanent topic dedupe, so a topic is never used twice across the channel's life. */
export interface TopicStore {
  hasUsed(key: string): Promise<boolean>
  markUsed(key: string, title: string): Promise<void>
}

export interface StoredClipRequest {
  sceneId: string
  prompt: string
  referenceImagePath: string | null
  targetSeconds: number
  fulfilledPath: string | null
  skipped: boolean
}

export interface ClipRequestStore {
  create(runId: string, requests: Omit<StoredClipRequest, 'fulfilledPath' | 'skipped'>[]): Promise<void>
  listForRun(runId: string): Promise<StoredClipRequest[]>
  markFulfilled(runId: string, sceneId: string, path: string): Promise<void>
  markSkipped(runId: string, sceneId: string): Promise<void>
}

/** AppConfig after the precedence merge, with the niche and preset already resolved. */
export interface ResolvedConfig extends AppConfig {
  nicheConfig: NicheConfig
  preset: FormatPreset
}

export interface RunContext {
  runId: string
  config: ResolvedConfig
  paths: RunPaths
  artifacts: ArtifactStore
  topics: TopicStore
  clipRequests: ClipRequestStore
  providers: ProviderBundle
  log: RunLogger
  clock: Clock
}

export type StageOutcome =
  | { status: 'done' }
  | { status: 'paused'; reason: 'awaiting_clips' }
  /** Quality gate and fact checker use this to stop the run with a readable reason. */
  | { status: 'halted'; reason: string }

export interface Stage {
  name: StageName
  requires: ModelRequirement
  run(ctx: RunContext): Promise<StageOutcome>
}
```

Append to `packages/core/src/index.ts`:

```ts
export * from './providers'
export * from './stage'
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — 3 new tests; whole suite green.

- [ ] **Step 6: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: exit code 0.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src
git commit -m "feat(core): add provider interfaces and stage contract"
```

---

### Task 6: Fake providers

Fakes are what make the whole pipeline testable without a single model. They must be complete implementations, not stubs that throw.

**Files:**
- Create: `packages/providers/package.json`, `packages/providers/tsconfig.json`
- Create: `packages/providers/src/fake/index.ts`, `packages/providers/src/index.ts`
- Test: `packages/providers/src/fake/fake.test.ts`

**Interfaces:**
- Consumes: the seven provider interfaces and `Clock` from Task 5
- Produces:
  - `createFakeProviders(opts?: { seed?: number }): ProviderBundle & { calls: FakeCallLog }`
  - `FixedClock` — `new FixedClock(iso: string)` implementing `Clock`, with `advance(ms)`
  - `FakeCallLog` — `{ published: PublishRequest[]; images: ImageRequest[]; spoken: TtsSpeakRequest[] }`

- [ ] **Step 1: Write the failing test**

Create `packages/providers/src/fake/fake.test.ts`:

```ts
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createFakeProviders, FixedClock } from '@yt/providers'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-fake-'))
})

describe('fake providers', () => {
  it('writes a real decodable WAV and reports its duration', async () => {
    const p = createFakeProviders()
    const out = path.join(dir, 'a.wav')
    const result = await p.tts.speak({ text: 'Hello there world', voice: 'male', outPath: out })

    expect(result.outPath).toBe(out)
    expect(result.durationSec).toBeGreaterThan(0)
    const stat = await fs.stat(out)
    expect(stat.size).toBeGreaterThan(44)
    const header = await fs.readFile(out)
    expect(header.subarray(0, 4).toString('ascii')).toBe('RIFF')
  })

  it('derives duration from word count so scene timing is deterministic', async () => {
    const p = createFakeProviders()
    const short = await p.tts.speak({ text: 'one two', voice: 'male', outPath: path.join(dir, 's.wav') })
    const long = await p.tts.speak({
      text: 'one two three four five six seven eight',
      voice: 'male',
      outPath: path.join(dir, 'l.wav'),
    })
    expect(long.durationSec).toBeGreaterThan(short.durationSec)
  })

  it('writes a real PNG file', async () => {
    const p = createFakeProviders()
    const out = path.join(dir, 'a.png')
    await p.image.generate({ prompt: 'x', width: 64, height: 64, seed: 1, outPath: out })
    const bytes = await fs.readFile(out)
    expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG')
  })

  it('records image requests for assertions', async () => {
    const p = createFakeProviders()
    await p.image.generate({ prompt: 'a cat', width: 8, height: 8, seed: 7, outPath: path.join(dir, 'c.png') })
    expect(p.calls.images).toHaveLength(1)
    expect(p.calls.images[0]).toMatchObject({ prompt: 'a cat', seed: 7 })
  })

  it('returns word-level captions covering the audio', async () => {
    const p = createFakeProviders()
    const out = path.join(dir, 'a.wav')
    await p.tts.speak({ text: 'alpha beta gamma', voice: 'male', outPath: out })
    const words = await p.caption.transcribe(out)
    expect(words.map((w) => w.word)).toEqual(['alpha', 'beta', 'gamma'])
    expect(words[0]!.startSec).toBe(0)
    expect(words[2]!.endSec).toBeGreaterThan(words[0]!.endSec)
  })

  it('pauses on manual clip requests and collects nothing until files appear', async () => {
    const p = createFakeProviders()
    const specs = [
      { sceneId: 's1', prompt: 'p', referenceImagePath: null, targetSeconds: 6, aspectRatio: '9:16' as const },
    ]
    await expect(p.clip.request(specs)).resolves.toEqual({ status: 'paused' })
    await expect(p.clip.collect(specs)).resolves.toEqual([{ sceneId: 's1', path: null }])
  })

  it('records publishes instead of performing them', async () => {
    const p = createFakeProviders()
    const result = await p.publish.publish({
      videoPath: 'v.mp4',
      thumbnailPath: 't.png',
      captionsPath: 'c.srt',
      title: 'T',
      description: 'D',
      tags: ['a'],
      privacy: 'private',
    })
    expect(result.videoId).toMatch(/^fake-/)
    expect(p.calls.published).toHaveLength(1)
  })

  it('returns deterministic trend candidates per source', async () => {
    const p = createFakeProviders()
    const first = await p.trend.fetchCandidates(['wikipedia-top'])
    const second = await p.trend.fetchCandidates(['wikipedia-top'])
    expect(first).toEqual(second)
    expect(first.length).toBeGreaterThan(0)
  })

  it('parses JSON through the caller supplied parser', async () => {
    const p = createFakeProviders()
    const value = await p.llm.json('prompt', 'Thing', (raw) => raw as { ok: boolean })
    expect(value).toEqual({ ok: true })
  })
})

describe('FixedClock', () => {
  it('does not move unless advanced', () => {
    const clock = new FixedClock('2026-08-01T12:00:00.000Z')
    expect(clock.now().toISOString()).toBe('2026-08-01T12:00:00.000Z')
    expect(clock.now().toISOString()).toBe('2026-08-01T12:00:00.000Z')
    clock.advance(3600_000)
    expect(clock.now().toISOString()).toBe('2026-08-01T13:00:00.000Z')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/providers`
Expected: FAIL — cannot resolve `@yt/providers`.

- [ ] **Step 3: Create the package files**

`packages/providers/package.json`:

```json
{
  "name": "@yt/providers",
  "version": "0.0.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": { "@yt/core": "workspace:*" }
}
```

`packages/providers/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 4: Write the fakes**

Create `packages/providers/src/fake/index.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  CaptionProvider,
  CaptionWord,
  ClipProvider,
  ClipRequestSpec,
  Clock,
  ImageProvider,
  ImageRequest,
  LlmProvider,
  ProviderBundle,
  PublishProvider,
  PublishRequest,
  TopicCandidate,
  TrendProvider,
  TtsProvider,
  TtsSpeakRequest,
} from '@yt/core'

/** Deterministic stand-in for wall-clock time. */
export class FixedClock implements Clock {
  private current: number

  constructor(iso: string) {
    this.current = new Date(iso).getTime()
  }

  now(): Date {
    return new Date(this.current)
  }

  advance(ms: number): void {
    this.current += ms
  }
}

export interface FakeCallLog {
  published: PublishRequest[]
  images: ImageRequest[]
  spoken: TtsSpeakRequest[]
}

/** Seconds of speech the fake attributes to each word. Keeps scene timing predictable. */
const SECONDS_PER_WORD = 0.5

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean)

/** A minimal but genuinely decodable 8-bit mono PCM WAV of the requested duration. */
const writeWav = async (outPath: string, durationSec: number) => {
  const sampleRate = 8000
  const samples = Math.max(1, Math.round(sampleRate * durationSec))
  const buffer = Buffer.alloc(44 + samples)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + samples, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate, 28)
  buffer.writeUInt16LE(1, 32)
  buffer.writeUInt16LE(8, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(samples, 40)
  buffer.fill(128, 44) // silence at 8-bit midpoint
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  await fs.writeFile(outPath, buffer)
}

/** A 1x1 opaque PNG. Real bytes, so ffprobe and image loaders accept it. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64',
)

export const createFakeProviders = (
  opts: { seed?: number } = {},
): ProviderBundle & { calls: FakeCallLog } => {
  const calls: FakeCallLog = { published: [], images: [], spoken: [] }
  const durations = new Map<string, { durationSec: number; text: string }>()
  let publishCounter = 0

  const llm: LlmProvider = {
    async complete(prompt) {
      return `fake completion for: ${prompt.slice(0, 40)}`
    },
    async json<T>(_prompt, _schemaName, parse): Promise<T> {
      return parse({ ok: true })
    },
    async unload() {},
  }

  const tts: TtsProvider = {
    async speak(req) {
      calls.spoken.push(req)
      const durationSec = Math.max(0.5, words(req.text).length * SECONDS_PER_WORD)
      await writeWav(req.outPath, durationSec)
      durations.set(req.outPath, { durationSec, text: req.text })
      return { outPath: req.outPath, durationSec }
    },
  }

  const image: ImageProvider = {
    async generate(req) {
      calls.images.push(req)
      await fs.mkdir(path.dirname(req.outPath), { recursive: true })
      await fs.writeFile(req.outPath, PNG_1PX)
      return { outPath: req.outPath }
    },
    async unload() {},
  }

  const clip: ClipProvider = {
    async request() {
      // Mirrors the manual adapter: the human must act, so the run pauses.
      return { status: 'paused' }
    },
    async collect(specs: ClipRequestSpec[]) {
      return specs.map((s) => ({ sceneId: s.sceneId, path: null }))
    },
  }

  const caption: CaptionProvider = {
    async transcribe(audioPath) {
      const entry = durations.get(audioPath)
      if (!entry) return []
      const list = words(entry.text)
      const per = entry.durationSec / list.length
      return list.map<CaptionWord>((word, i) => ({
        word,
        startSec: Number((i * per).toFixed(3)),
        endSec: Number(((i + 1) * per).toFixed(3)),
      }))
    },
  }

  const publish: PublishProvider = {
    async publish(req) {
      calls.published.push(req)
      publishCounter += 1
      return { videoId: `fake-${opts.seed ?? 0}-${publishCounter}` }
    },
  }

  const trend: TrendProvider = {
    async fetchCandidates(sources) {
      return sources.flatMap<TopicCandidate>((source, si) =>
        Array.from({ length: 3 }, (_, i) => ({
          key: `${source}-${si}-${i}`,
          title: `Fake candidate ${i} from ${source}`,
          source,
          url: `https://example.invalid/${source}/${i}`,
        })),
      )
    },
  }

  return { llm, tts, image, clip, caption, publish, trend, calls }
}
```

Create `packages/providers/src/index.ts`:

```ts
export * from './fake'
```

- [ ] **Step 5: Install the workspace link**

Run: `pnpm install`
Expected: `@yt/providers` linked to `@yt/core`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — 10 new tests (9 fake providers, 1 clock); whole suite green.

- [ ] **Step 7: Commit**

```bash
git add packages/providers pnpm-lock.yaml
git commit -m "feat(providers): add fake providers and deterministic clock"
```

---

### Task 7: Prisma schema, test database harness, and repositories

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/prisma/schema.prisma`
- Create: `packages/db/src/client.ts`, `packages/db/src/index.ts`
- Create: `packages/db/src/repositories/{run,topic,job,clip}.repository.ts`
- Create: `test/setup/global-db.ts`, `test/setup/db.ts`
- Modify: `vitest.config.ts` (register global setup)
- Modify: `.gitignore` (ignore generated Prisma client and test databases)
- Test: `packages/db/src/repositories/repositories.test.ts`

**Interfaces:**
- Consumes: `RunStatus`, `StageName` from Task 2; `TopicStore`, `ClipRequestStore`, `StoredClipRequest` from Task 5
- Produces:
  - `createPrismaClient(databaseUrl: string)`
  - `RunRepository` — `create`, `get`, `setStatus`, `startStage`, `finishStage`, `failStage`, `completedStages`, `recordVideoId`
  - `TopicRepository implements TopicStore`
  - `ClipRepository implements ClipRequestStore`
  - `JobRepository` — `enqueue`, `claimNext`, `complete`, `fail`
  - `type Repositories = { runs, topics, clips, jobs }` and `createRepositories(prisma)`
  - Test helpers `createTestDb(): Promise<{ prisma, repos, cleanup }>`

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/repositories/repositories.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '../../../../test/setup/db'
import type { Repositories } from '@yt/db'

let repos: Repositories
let cleanup: () => Promise<void>

beforeEach(async () => {
  const db = await createTestDb()
  repos = db.repos
  cleanup = db.cleanup
})

afterEach(async () => {
  await cleanup()
})

const newRun = () =>
  repos.runs.create({
    id: 'run-1',
    niche: 'space',
    format: 'long',
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
  })

describe('RunRepository', () => {
  it('creates a run in the queued state', async () => {
    await newRun()
    const run = await repos.runs.get('run-1')
    expect(run).toMatchObject({ id: 'run-1', niche: 'space', format: 'long', status: 'queued' })
  })

  it('records stage completion so runs can resume', async () => {
    await newRun()
    await repos.runs.startStage('run-1', 'topic-scout', new Date('2026-08-01T10:00:01.000Z'))
    await repos.runs.finishStage('run-1', 'topic-scout', new Date('2026-08-01T10:00:05.000Z'))

    expect(await repos.runs.completedStages('run-1')).toEqual(['topic-scout'])
  })

  it('does not report a failed stage as completed', async () => {
    await newRun()
    await repos.runs.startStage('run-1', 'researcher', new Date('2026-08-01T10:00:01.000Z'))
    await repos.runs.failStage('run-1', 'researcher', 'wikipedia unreachable', new Date('2026-08-01T10:00:02.000Z'))

    expect(await repos.runs.completedStages('run-1')).toEqual([])
    const stages = await repos.runs.stages('run-1')
    expect(stages[0]).toMatchObject({ status: 'failed', error: 'wikipedia unreachable', attempts: 1 })
  })

  it('counts attempts across retries of the same stage', async () => {
    await newRun()
    for (let i = 0; i < 3; i++) {
      await repos.runs.startStage('run-1', 'seo', new Date('2026-08-01T10:00:01.000Z'))
      await repos.runs.failStage('run-1', 'seo', 'bad json', new Date('2026-08-01T10:00:02.000Z'))
    }
    const stages = await repos.runs.stages('run-1')
    expect(stages[0]!.attempts).toBe(3)
  })

  it('stores the published video id', async () => {
    await newRun()
    await repos.runs.recordVideoId('run-1', 'abc123')
    expect((await repos.runs.get('run-1'))!.videoId).toBe('abc123')
  })

  it('moves a run into the awaiting_clips paused state', async () => {
    await newRun()
    await repos.runs.setStatus('run-1', 'awaiting_clips')
    expect((await repos.runs.get('run-1'))!.status).toBe('awaiting_clips')
  })
})

describe('TopicRepository', () => {
  it('reports a topic as unused before it is marked', async () => {
    expect(await repos.topics.hasUsed('venus-retrograde')).toBe(false)
  })

  it('permanently dedupes a used topic', async () => {
    await repos.topics.markUsed('venus-retrograde', 'Why Venus spins backwards')
    expect(await repos.topics.hasUsed('venus-retrograde')).toBe(true)
  })

  it('is idempotent when the same topic is marked twice', async () => {
    await repos.topics.markUsed('venus-retrograde', 'Why Venus spins backwards')
    await expect(
      repos.topics.markUsed('venus-retrograde', 'Why Venus spins backwards'),
    ).resolves.toBeUndefined()
  })
})

describe('ClipRepository', () => {
  beforeEach(async () => {
    await newRun()
    await repos.clips.create('run-1', [
      { sceneId: 's3', prompt: 'dust storm', referenceImagePath: '/img/s3.png', targetSeconds: 6.4 },
      { sceneId: 's9', prompt: 'city at dusk', referenceImagePath: null, targetSeconds: 7 },
    ])
  })

  it('lists requests as unfulfilled', async () => {
    const list = await repos.clips.listForRun('run-1')
    expect(list).toHaveLength(2)
    expect(list.every((c) => c.fulfilledPath === null && !c.skipped)).toBe(true)
  })

  it('marks a request fulfilled with its normalised path', async () => {
    await repos.clips.markFulfilled('run-1', 's3', '/clips/normalised/scene-003.mp4')
    const list = await repos.clips.listForRun('run-1')
    expect(list.find((c) => c.sceneId === 's3')!.fulfilledPath).toBe('/clips/normalised/scene-003.mp4')
  })

  it('marks a request skipped so the image fallback is used', async () => {
    await repos.clips.markSkipped('run-1', 's9')
    const list = await repos.clips.listForRun('run-1')
    expect(list.find((c) => c.sceneId === 's9')!.skipped).toBe(true)
  })
})

describe('JobRepository', () => {
  it('claims a queued job exactly once', async () => {
    await repos.jobs.enqueue('generate', { runId: 'run-1' }, new Date('2026-08-01T10:00:00.000Z'))
    const first = await repos.jobs.claimNext(new Date('2026-08-01T10:00:01.000Z'))
    const second = await repos.jobs.claimNext(new Date('2026-08-01T10:00:02.000Z'))

    expect(first).toMatchObject({ type: 'generate', payload: { runId: 'run-1' } })
    expect(second).toBeNull()
  })

  it('requeues a failed job until the attempt limit, then fails it', async () => {
    await repos.jobs.enqueue('generate', { runId: 'run-1' }, new Date('2026-08-01T10:00:00.000Z'))

    const job = await repos.jobs.claimNext(new Date('2026-08-01T10:00:01.000Z'))
    await repos.jobs.fail(job!.id, 'boom', 2, new Date('2026-08-01T10:00:02.000Z'))
    const retry = await repos.jobs.claimNext(new Date('2026-08-01T10:00:03.000Z'))
    expect(retry?.id).toBe(job!.id)

    await repos.jobs.fail(retry!.id, 'boom again', 2, new Date('2026-08-01T10:00:04.000Z'))
    expect(await repos.jobs.claimNext(new Date('2026-08-01T10:00:05.000Z'))).toBeNull()
  })

  it('does not requeue a completed job', async () => {
    await repos.jobs.enqueue('generate', { runId: 'run-1' }, new Date('2026-08-01T10:00:00.000Z'))
    const job = await repos.jobs.claimNext(new Date('2026-08-01T10:00:01.000Z'))
    await repos.jobs.complete(job!.id, new Date('2026-08-01T10:00:02.000Z'))
    expect(await repos.jobs.claimNext(new Date('2026-08-01T10:00:03.000Z'))).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/db`
Expected: FAIL — cannot resolve `@yt/db` or the test helper.

- [ ] **Step 3: Create the package and Prisma schema**

`packages/db/package.json`:

```json
{
  "name": "@yt/db",
  "version": "0.0.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "db:push": "prisma db push --schema prisma/schema.prisma",
    "db:generate": "prisma generate --schema prisma/schema.prisma"
  },
  "dependencies": {
    "@prisma/client": "^5.22.0",
    "@yt/core": "workspace:*"
  },
  "devDependencies": {
    "prisma": "^5.22.0"
  }
}
```

`packages/db/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": ".", "outDir": "dist" },
  "include": ["src/**/*.ts", "generated/**/*.ts"]
}
```

`packages/db/prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
  output   = "../generated/client"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model Run {
  id        String   @id
  niche     String
  format    String
  status    String   @default("queued")
  videoId   String?
  createdAt DateTime
  updatedAt DateTime @updatedAt

  stages       StageRun[]
  assets       Asset[]
  titles       TitleCandidate[]
  clipRequests ClipRequest[]

  @@index([status])
  @@index([niche])
}

model StageRun {
  id        Int       @id @default(autoincrement())
  runId     String
  name      String
  status    String
  attempts  Int       @default(0)
  error     String?
  startedAt DateTime?
  endedAt   DateTime?

  run Run @relation(fields: [runId], references: [id], onDelete: Cascade)

  @@unique([runId, name])
}

model Topic {
  key       String   @id
  title     String
  usedAt    DateTime @default(now())
}

model Asset {
  id     Int    @id @default(autoincrement())
  runId  String
  kind   String
  path   String

  run Run @relation(fields: [runId], references: [id], onDelete: Cascade)

  @@index([runId, kind])
}

model TitleCandidate {
  id       Int     @id @default(autoincrement())
  runId    String
  title    String
  total    Float
  chosen   Boolean @default(false)

  run Run @relation(fields: [runId], references: [id], onDelete: Cascade)

  @@index([runId])
}

model ClipRequest {
  id                 Int      @id @default(autoincrement())
  runId              String
  sceneId            String
  prompt             String
  referenceImagePath String?
  targetSeconds      Float
  fulfilledPath      String?
  skipped            Boolean  @default(false)

  run Run @relation(fields: [runId], references: [id], onDelete: Cascade)

  @@unique([runId, sceneId])
}

model Job {
  id          Int       @id @default(autoincrement())
  type        String
  payload     String
  state       String    @default("queued")
  attempts    Int       @default(0)
  error       String?
  createdAt   DateTime
  claimedAt   DateTime?
  finishedAt  DateTime?

  @@index([state])
}
```

- [ ] **Step 4: Install and generate the client**

Run: `pnpm install && pnpm --filter @yt/db db:generate`
Expected: client emitted to `packages/db/generated/client`.

- [ ] **Step 5: Ignore generated artifacts**

Append to `.gitignore`:

```gitignore
# Prisma generated client
packages/db/generated/
# Test databases
storage/test-*.db
```

- [ ] **Step 6: Write the client and repositories**

`packages/db/src/client.ts`:

```ts
import { PrismaClient } from '../generated/client'

export const createPrismaClient = (databaseUrl: string): PrismaClient =>
  new PrismaClient({ datasources: { db: { url: databaseUrl } } })

export type { PrismaClient }
```

`packages/db/src/repositories/run.repository.ts`:

```ts
import type { RunStatus, StageName, VideoFormat } from '@yt/core'
import type { PrismaClient } from '../client'

export interface StageRecord {
  name: StageName
  status: 'running' | 'done' | 'failed'
  attempts: number
  error: string | null
}

export class RunRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: {
    id: string
    niche: string
    format: VideoFormat
    createdAt: Date
  }): Promise<void> {
    await this.prisma.run.create({
      data: { ...input, status: 'queued', updatedAt: input.createdAt },
    })
  }

  async get(id: string) {
    const run = await this.prisma.run.findUnique({ where: { id } })
    return run as (Omit<NonNullable<typeof run>, 'status'> & { status: RunStatus }) | null
  }

  async setStatus(id: string, status: RunStatus): Promise<void> {
    await this.prisma.run.update({ where: { id }, data: { status } })
  }

  async recordVideoId(id: string, videoId: string): Promise<void> {
    await this.prisma.run.update({ where: { id }, data: { videoId } })
  }

  /** Upserts so a retry of the same stage increments attempts rather than duplicating. */
  async startStage(runId: string, name: StageName, at: Date): Promise<void> {
    await this.prisma.stageRun.upsert({
      where: { runId_name: { runId, name } },
      create: { runId, name, status: 'running', attempts: 1, startedAt: at },
      update: { status: 'running', attempts: { increment: 1 }, startedAt: at, error: null },
    })
  }

  async finishStage(runId: string, name: StageName, at: Date): Promise<void> {
    await this.prisma.stageRun.update({
      where: { runId_name: { runId, name } },
      data: { status: 'done', endedAt: at, error: null },
    })
  }

  async failStage(runId: string, name: StageName, error: string, at: Date): Promise<void> {
    await this.prisma.stageRun.update({
      where: { runId_name: { runId, name } },
      data: { status: 'failed', error, endedAt: at },
    })
  }

  async stages(runId: string): Promise<StageRecord[]> {
    const rows = await this.prisma.stageRun.findMany({ where: { runId }, orderBy: { id: 'asc' } })
    return rows.map((r) => ({
      name: r.name as StageName,
      status: r.status as StageRecord['status'],
      attempts: r.attempts,
      error: r.error,
    }))
  }

  /** The resume mechanism: stages already done are skipped on a re-run. */
  async completedStages(runId: string): Promise<StageName[]> {
    const rows = await this.prisma.stageRun.findMany({
      where: { runId, status: 'done' },
      orderBy: { id: 'asc' },
    })
    return rows.map((r) => r.name as StageName)
  }
}
```

`packages/db/src/repositories/topic.repository.ts`:

```ts
import type { TopicStore } from '@yt/core'
import type { PrismaClient } from '../client'

export class TopicRepository implements TopicStore {
  constructor(private readonly prisma: PrismaClient) {}

  async hasUsed(key: string): Promise<boolean> {
    return (await this.prisma.topic.findUnique({ where: { key } })) !== null
  }

  async markUsed(key: string, title: string): Promise<void> {
    await this.prisma.topic.upsert({ where: { key }, create: { key, title }, update: {} })
  }
}
```

`packages/db/src/repositories/clip.repository.ts`:

```ts
import type { ClipRequestStore, StoredClipRequest } from '@yt/core'
import type { PrismaClient } from '../client'

export class ClipRepository implements ClipRequestStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(
    runId: string,
    requests: Omit<StoredClipRequest, 'fulfilledPath' | 'skipped'>[],
  ): Promise<void> {
    for (const r of requests) {
      await this.prisma.clipRequest.upsert({
        where: { runId_sceneId: { runId, sceneId: r.sceneId } },
        create: { runId, ...r },
        update: { prompt: r.prompt, targetSeconds: r.targetSeconds },
      })
    }
  }

  async listForRun(runId: string): Promise<StoredClipRequest[]> {
    const rows = await this.prisma.clipRequest.findMany({ where: { runId }, orderBy: { id: 'asc' } })
    return rows.map((r) => ({
      sceneId: r.sceneId,
      prompt: r.prompt,
      referenceImagePath: r.referenceImagePath,
      targetSeconds: r.targetSeconds,
      fulfilledPath: r.fulfilledPath,
      skipped: r.skipped,
    }))
  }

  async markFulfilled(runId: string, sceneId: string, path: string): Promise<void> {
    await this.prisma.clipRequest.update({
      where: { runId_sceneId: { runId, sceneId } },
      data: { fulfilledPath: path, skipped: false },
    })
  }

  async markSkipped(runId: string, sceneId: string): Promise<void> {
    await this.prisma.clipRequest.update({
      where: { runId_sceneId: { runId, sceneId } },
      data: { skipped: true },
    })
  }
}
```

`packages/db/src/repositories/job.repository.ts`:

```ts
import type { PrismaClient } from '../client'

export interface ClaimedJob {
  id: number
  type: string
  payload: Record<string, unknown>
  attempts: number
}

export class JobRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async enqueue(type: string, payload: Record<string, unknown>, at: Date): Promise<number> {
    const row = await this.prisma.job.create({
      data: { type, payload: JSON.stringify(payload), createdAt: at },
    })
    return row.id
  }

  /** Concurrency is 1, so a simple find-then-update claim is sufficient here. */
  async claimNext(at: Date): Promise<ClaimedJob | null> {
    const row = await this.prisma.job.findFirst({
      where: { state: 'queued' },
      orderBy: { id: 'asc' },
    })
    if (!row) return null

    await this.prisma.job.update({
      where: { id: row.id },
      data: { state: 'running', claimedAt: at },
    })

    return {
      id: row.id,
      type: row.type,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      attempts: row.attempts,
    }
  }

  async complete(id: number, at: Date): Promise<void> {
    await this.prisma.job.update({
      where: { id },
      data: { state: 'done', finishedAt: at, error: null },
    })
  }

  /** Requeues while attempts remain, otherwise marks the job permanently failed. */
  async fail(id: number, error: string, maxAttempts: number, at: Date): Promise<void> {
    const row = await this.prisma.job.update({
      where: { id },
      data: { attempts: { increment: 1 }, error },
    })
    await this.prisma.job.update({
      where: { id },
      data:
        row.attempts >= maxAttempts
          ? { state: 'failed', finishedAt: at }
          : { state: 'queued', claimedAt: null },
    })
  }
}
```

`packages/db/src/index.ts`:

```ts
import type { PrismaClient } from './client'
import { ClipRepository } from './repositories/clip.repository'
import { JobRepository } from './repositories/job.repository'
import { RunRepository } from './repositories/run.repository'
import { TopicRepository } from './repositories/topic.repository'

export * from './client'
export * from './repositories/clip.repository'
export * from './repositories/job.repository'
export * from './repositories/run.repository'
export * from './repositories/topic.repository'

export interface Repositories {
  runs: RunRepository
  topics: TopicRepository
  clips: ClipRepository
  jobs: JobRepository
}

export const createRepositories = (prisma: PrismaClient): Repositories => ({
  runs: new RunRepository(prisma),
  topics: new TopicRepository(prisma),
  clips: new ClipRepository(prisma),
  jobs: new JobRepository(prisma),
})
```

- [ ] **Step 7: Write the test database harness**

The template database is built once by a global setup, then copied per test. Copying a file is far faster than running a migration per test.

Create `test/setup/global-db.ts`:

```ts
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const TEMPLATE_DB = path.resolve(__dirname, '../../storage/test-template.db')

export default function globalSetup() {
  fs.mkdirSync(path.dirname(TEMPLATE_DB), { recursive: true })
  fs.rmSync(TEMPLATE_DB, { force: true })

  const schema = path.resolve(__dirname, '../../packages/db/prisma/schema.prisma')
  execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--schema', schema, '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: `file:${TEMPLATE_DB}` },
    stdio: 'inherit',
  })
}
```

Create `test/setup/db.ts`:

```ts
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPrismaClient, createRepositories, type Repositories } from '@yt/db'
import { TEMPLATE_DB } from './global-db'

let counter = 0

export const createTestDb = async (): Promise<{
  prisma: ReturnType<typeof createPrismaClient>
  repos: Repositories
  cleanup: () => Promise<void>
}> => {
  counter += 1
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `yt-db-${counter}-`))
  const file = path.join(dir, 'test.db')
  await fs.copyFile(TEMPLATE_DB, file)

  const prisma = createPrismaClient(`file:${file}`)
  return {
    prisma,
    repos: createRepositories(prisma),
    cleanup: async () => {
      await prisma.$disconnect()
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}
```

- [ ] **Step 8: Register the global setup**

Modify `vitest.config.ts` — add to the `test` block:

```ts
    globalSetup: ['./test/setup/global-db.ts'],
    testTimeout: 20_000,
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — 15 new tests (6 run, 3 topic, 3 clip, 3 job); whole suite green. The first run prints Prisma's `db push` output from the global setup.

- [ ] **Step 10: Commit**

```bash
git add packages/db test vitest.config.ts .gitignore pnpm-lock.yaml
git commit -m "feat(db): add prisma schema, repositories and per-test database harness"
```

---

### Task 8: ModelBroker

The single most important safety mechanism in the system. On 16 GB of unified memory, two heavy models resident at once means thrashing. The broker makes that structurally impossible.

**Files:**
- Create: `packages/pipeline/package.json`, `packages/pipeline/tsconfig.json`
- Create: `packages/pipeline/src/model-broker.ts`
- Create: `packages/pipeline/src/index.ts`
- Test: `packages/pipeline/src/model-broker.test.ts`

**Interfaces:**
- Consumes: `ModelRequirement` from Task 2
- Produces:
  - `interface Evictable { readonly id: 'llm' | 'sd'; unload(): Promise<void> }`
  - `interface ModelLease { release(): void }`
  - `class ModelBroker` — `constructor(evictables: Evictable[])`, `acquire(req: ModelRequirement): Promise<ModelLease>`, `get resident(): 'llm' | 'sd' | null`, `evictAll(): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `packages/pipeline/src/model-broker.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { ModelBroker, type Evictable } from '@yt/pipeline'

const evictable = (id: 'llm' | 'sd') => {
  const unload = vi.fn(async () => {})
  return { evictable: { id, unload } satisfies Evictable, unload }
}

describe('ModelBroker', () => {
  it('starts with nothing resident', () => {
    const broker = new ModelBroker([])
    expect(broker.resident).toBeNull()
  })

  it('marks a model resident once acquired', async () => {
    const llm = evictable('llm')
    const broker = new ModelBroker([llm.evictable])

    const lease = await broker.acquire('llm')
    expect(broker.resident).toBe('llm')
    lease.release()
  })

  it('does not unload anything when re-acquiring the resident model', async () => {
    const llm = evictable('llm')
    const broker = new ModelBroker([llm.evictable])

    ;(await broker.acquire('llm')).release()
    ;(await broker.acquire('llm')).release()

    expect(llm.unload).not.toHaveBeenCalled()
  })

  it('evicts the resident model before admitting a different one', async () => {
    const llm = evictable('llm')
    const sd = evictable('sd')
    const broker = new ModelBroker([llm.evictable, sd.evictable])

    ;(await broker.acquire('llm')).release()
    ;(await broker.acquire('sd')).release()

    expect(llm.unload).toHaveBeenCalledTimes(1)
    expect(sd.unload).not.toHaveBeenCalled()
    expect(broker.resident).toBe('sd')
  })

  it("leaves the resident model untouched for a 'none' requirement", async () => {
    const llm = evictable('llm')
    const broker = new ModelBroker([llm.evictable])

    ;(await broker.acquire('llm')).release()
    ;(await broker.acquire('none')).release()

    expect(llm.unload).not.toHaveBeenCalled()
    expect(broker.resident).toBe('llm')
  })

  it('performs exactly two evictions across the full stage sequence', async () => {
    const llm = evictable('llm')
    const sd = evictable('sd')
    const broker = new ModelBroker([llm.evictable, sd.evictable])
    const sequence: Array<'llm' | 'sd' | 'none'> = [
      'llm', 'llm', 'llm', 'llm', 'llm', 'llm',
      'sd', 'sd',
      'none', 'none', 'none', 'none', 'none', 'none',
    ]

    for (const req of sequence) {
      ;(await broker.acquire(req)).release()
    }

    // llm evicted once when sd arrives; sd evicted once by evictAll at the end.
    expect(llm.unload).toHaveBeenCalledTimes(1)
    await broker.evictAll()
    expect(sd.unload).toHaveBeenCalledTimes(1)
    expect(broker.resident).toBeNull()
  })

  it('serialises concurrent acquisitions so two models never overlap', async () => {
    const llm = evictable('llm')
    const sd = evictable('sd')
    const broker = new ModelBroker([llm.evictable, sd.evictable])
    const observed: string[] = []

    const first = broker.acquire('llm').then(async (lease) => {
      observed.push('llm-start')
      await new Promise((r) => setTimeout(r, 20))
      observed.push('llm-end')
      lease.release()
    })

    const second = broker.acquire('sd').then((lease) => {
      observed.push('sd-start')
      lease.release()
    })

    await Promise.all([first, second])
    expect(observed).toEqual(['llm-start', 'llm-end', 'sd-start'])
  })

  it('releases the lock even when the caller throws', async () => {
    const llm = evictable('llm')
    const broker = new ModelBroker([llm.evictable])

    const lease = await broker.acquire('llm')
    try {
      throw new Error('stage blew up')
    } catch {
      lease.release()
    }

    // If the lock leaked, this would hang rather than resolve.
    await expect(broker.acquire('llm')).resolves.toBeDefined()
  })

  it('throws when asked for a model it was not given', async () => {
    const broker = new ModelBroker([])
    await expect(broker.acquire('llm')).rejects.toThrow(/no evictable registered for 'llm'/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/pipeline`
Expected: FAIL — cannot resolve `@yt/pipeline`.

- [ ] **Step 3: Create the package files**

`packages/pipeline/package.json`:

```json
{
  "name": "@yt/pipeline",
  "version": "0.0.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "@yt/core": "workspace:*",
    "@yt/db": "workspace:*",
    "@yt/providers": "workspace:*",
    "zod": "^3.23.0"
  }
}
```

`packages/pipeline/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 4: Write the implementation**

Create `packages/pipeline/src/model-broker.ts`:

```ts
import type { ModelRequirement } from '@yt/core'

export interface Evictable {
  readonly id: 'llm' | 'sd'
  unload(): Promise<void>
}

export interface ModelLease {
  release(): void
}

/**
 * Guarantees at most one heavy model is memory-resident.
 *
 * The target machine has 16 GB of unified memory. An 8B LLM (~6 GB) and SDXL (~8 GB)
 * cannot coexist alongside a rendering Chromium (~3 GB), so admission is serialised and
 * a differing request evicts the incumbent first.
 */
export class ModelBroker {
  private readonly evictables: Map<'llm' | 'sd', Evictable>
  private current: 'llm' | 'sd' | null = null
  /** Tail of the FIFO admission queue. Each acquire chains onto the previous one. */
  private tail: Promise<void> = Promise.resolve()

  constructor(evictables: Evictable[]) {
    this.evictables = new Map(evictables.map((e) => [e.id, e]))
  }

  get resident(): 'llm' | 'sd' | null {
    return this.current
  }

  async acquire(requirement: ModelRequirement): Promise<ModelLease> {
    // A stage needing no model must not queue behind model work.
    if (requirement === 'none') {
      return { release: () => {} }
    }

    const evictable = this.evictables.get(requirement)
    if (!evictable) {
      throw new Error(`ModelBroker: no evictable registered for '${requirement}'`)
    }

    let releaseLock!: () => void
    const held = new Promise<void>((resolve) => {
      releaseLock = resolve
    })

    const waitFor = this.tail
    this.tail = waitFor.then(() => held)
    await waitFor

    if (this.current !== null && this.current !== requirement) {
      const incumbent = this.evictables.get(this.current)
      if (incumbent) await incumbent.unload()
      this.current = null
    }
    this.current = requirement

    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        releaseLock()
      },
    }
  }

  /** Frees all model memory. Call at the end of a run, or before rendering. */
  async evictAll(): Promise<void> {
    if (this.current === null) return
    const incumbent = this.evictables.get(this.current)
    if (incumbent) await incumbent.unload()
    this.current = null
  }
}
```

Create `packages/pipeline/src/index.ts`:

```ts
export * from './model-broker'
```

- [ ] **Step 5: Install and run the tests**

Run: `pnpm install && pnpm test`
Expected: PASS — 9 new broker tests; whole suite green.

- [ ] **Step 6: Commit**

```bash
git add packages/pipeline pnpm-lock.yaml
git commit -m "feat(pipeline): add ModelBroker enforcing a single resident model"
```

---

### Task 9: Config resolution and loading

**Files:**
- Create: `packages/pipeline/src/config/resolve.ts`, `packages/pipeline/src/config/load.ts`
- Modify: `packages/pipeline/src/index.ts`
- Test: `packages/pipeline/src/config/resolve.test.ts`, `packages/pipeline/src/config/load.test.ts`

**Interfaces:**
- Consumes: `AppConfigSchema`, `NicheConfigSchema`, `DEFAULT_APP_CONFIG` from Task 4; `ResolvedConfig` from Task 5; `FORMAT_PRESETS` from Task 2
- Produces:
  - `resolveConfig(input: { request?: Partial<AppConfig>; app?: unknown; niche: unknown }): ResolvedConfig`
  - `loadConfig(opts: { configDir: string; request?: Partial<AppConfig> }): Promise<ResolvedConfig>`
  - `listNiches(configDir: string): Promise<NicheConfig[]>`

- [ ] **Step 1: Write the failing tests**

Create `packages/pipeline/src/config/resolve.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG } from '@yt/core'
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
})
```

Create `packages/pipeline/src/config/load.test.ts`:

```ts
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listNiches, loadConfig } from '@yt/pipeline'

const configDir = path.resolve(__dirname, '../../../../config')

describe('loadConfig', () => {
  it('loads app.json together with the niche named in it', async () => {
    const resolved = await loadConfig({ configDir })
    expect(resolved.nicheConfig.id).toBe(resolved.niche)
  })

  it('honours a per-run niche override', async () => {
    const resolved = await loadConfig({ configDir, request: { niche: 'politics' } })
    expect(resolved.nicheConfig.id).toBe('politics')
    expect(resolved.nicheConfig.monetizationRisk).toBe('high')
  })

  it('fails clearly when the niche file is missing', async () => {
    await expect(loadConfig({ configDir, request: { niche: 'crypto' } })).rejects.toThrow(
      /niche 'crypto' not found/,
    )
  })

  it('lists all eight shipped niches', async () => {
    const niches = await listNiches(configDir)
    expect(niches.map((n) => n.id).sort()).toEqual([
      'ai',
      'education',
      'knowledge',
      'politics',
      'programming',
      'science',
      'space',
      'tech',
    ])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/pipeline/src/config`
Expected: FAIL — `resolveConfig` is not exported from `@yt/pipeline`.

- [ ] **Step 3: Write the implementation**

Create `packages/pipeline/src/config/resolve.ts`:

```ts
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
```

Create `packages/pipeline/src/config/load.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { NicheConfigSchema, type AppConfig, type NicheConfig, type ResolvedConfig } from '@yt/core'
import { resolveConfig } from './resolve'

const readJson = async (file: string): Promise<unknown> =>
  JSON.parse(await fs.readFile(file, 'utf8'))

export const listNiches = async (configDir: string): Promise<NicheConfig[]> => {
  const dir = path.join(configDir, 'niches')
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'))
  const niches: NicheConfig[] = []
  for (const file of files.sort()) {
    niches.push(NicheConfigSchema.parse(await readJson(path.join(dir, file))))
  }
  return niches
}

export const loadConfig = async (opts: {
  configDir: string
  request?: Partial<AppConfig>
}): Promise<ResolvedConfig> => {
  const app = (await readJson(path.join(opts.configDir, 'app.json'))) as Partial<AppConfig>
  const nicheId = opts.request?.niche ?? app.niche
  if (!nicheId) throw new Error('no niche specified in the request or app.json')

  const nicheFile = path.join(opts.configDir, 'niches', `${nicheId}.json`)
  let niche: unknown
  try {
    niche = await readJson(nicheFile)
  } catch {
    throw new Error(`niche '${nicheId}' not found at ${nicheFile}`)
  }

  return resolveConfig({ request: opts.request, app, niche })
}
```

Append to `packages/pipeline/src/index.ts`:

```ts
export * from './config/resolve'
export * from './config/load'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — 14 new tests (10 precedence, 4 loading); whole suite green.

- [ ] **Step 5: Commit**

```bash
git add packages/pipeline/src
git commit -m "feat(pipeline): add config resolution with documented precedence"
```

---

### Task 10: Run storage, artifact store, and logger

**Files:**
- Create: `packages/pipeline/src/storage/paths.ts`, `packages/pipeline/src/storage/artifacts.ts`, `packages/pipeline/src/logger.ts`
- Modify: `packages/pipeline/src/index.ts`
- Test: `packages/pipeline/src/storage/paths.test.ts`, `packages/pipeline/src/storage/artifacts.test.ts`, `packages/pipeline/src/logger.test.ts`

**Interfaces:**
- Consumes: `RunPaths`, `ArtifactStore`, `ArtifactName`, `RunLogger` from Task 5
- Produces:
  - `runPaths(storageRoot: string, runId: string): RunPaths`
  - `ensureRunDirs(paths: RunPaths): Promise<void>`
  - `class FileArtifactStore implements ArtifactStore` — `constructor(paths: RunPaths)`
  - `class EventRunLogger implements RunLogger` — `constructor(runId, sink: (entry: LogEntry) => void)`
  - `type LogEntry = { runId, level, message, meta?, at? }`

- [ ] **Step 1: Write the failing tests**

Create `packages/pipeline/src/storage/paths.test.ts`:

```ts
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { ensureRunDirs, runPaths } from '@yt/pipeline'

describe('runPaths', () => {
  it('lays out one self-contained directory per run', () => {
    const p = runPaths('/storage', 'run-1')
    expect(p.root).toBe(path.join('/storage', 'videos', 'run-1'))
    expect(p.audio).toBe(path.join(p.root, 'audio'))
    expect(p.images).toBe(path.join(p.root, 'images'))
    expect(p.clipsInbox).toBe(path.join(p.root, 'clips', 'inbox'))
    expect(p.clipsNormalised).toBe(path.join(p.root, 'clips', 'normalised'))
    expect(p.captions).toBe(path.join(p.root, 'captions'))
    expect(p.thumbnail).toBe(path.join(p.root, 'thumbnail'))
    expect(p.out).toBe(path.join(p.root, 'out'))
  })

  it('produces absolute paths from a relative storage root', () => {
    expect(path.isAbsolute(runPaths('./storage', 'run-1').root)).toBe(true)
  })

  it('creates every directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-paths-'))
    const p = runPaths(dir, 'run-1')
    await ensureRunDirs(p)

    for (const target of [p.audio, p.images, p.clipsInbox, p.clipsNormalised, p.captions, p.thumbnail, p.out]) {
      expect((await fs.stat(target)).isDirectory()).toBe(true)
    }
  })
})
```

Create `packages/pipeline/src/storage/artifacts.test.ts`:

```ts
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ensureRunDirs, FileArtifactStore, runPaths } from '@yt/pipeline'

const Schema = z.object({ topicTitle: z.string(), count: z.number() })

let store: FileArtifactStore
let root: string

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-art-'))
  const paths = runPaths(dir, 'run-1')
  await ensureRunDirs(paths)
  root = paths.root
  store = new FileArtifactStore(paths)
})

describe('FileArtifactStore', () => {
  it('round-trips an artifact', async () => {
    await store.write('research', Schema, { topicTitle: 'Venus', count: 3 })
    expect(await store.read('research', Schema)).toEqual({ topicTitle: 'Venus', count: 3 })
  })

  it('writes human-readable JSON so a run can be inspected by hand', async () => {
    await store.write('research', Schema, { topicTitle: 'Venus', count: 3 })
    const raw = await fs.readFile(path.join(root, 'research.json'), 'utf8')
    expect(raw).toContain('\n  "topicTitle"')
  })

  it('reports existence without reading', async () => {
    expect(await store.exists('script')).toBe(false)
    await store.write('script', Schema, { topicTitle: 'Venus', count: 1 })
    expect(await store.exists('script')).toBe(true)
  })

  it('refuses to write data that violates the schema', async () => {
    await expect(
      store.write('research', Schema, { topicTitle: 'Venus', count: 'three' } as never),
    ).rejects.toThrow(/artifact 'research' failed validation/)
  })

  it('fails loudly when reading a file that violates the schema', async () => {
    await fs.writeFile(path.join(root, 'seo.json'), JSON.stringify({ topicTitle: 'x' }))
    await expect(store.read('seo', Schema)).rejects.toThrow(/artifact 'seo' failed validation/)
  })

  it('fails clearly when the artifact is absent', async () => {
    await expect(store.read('videoSpec', Schema)).rejects.toThrow(/artifact 'videoSpec' not found/)
  })
})
```

Create `packages/pipeline/src/logger.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { EventRunLogger, type LogEntry } from '@yt/pipeline'

describe('EventRunLogger', () => {
  it('tags every entry with the run id and level', () => {
    const sink = vi.fn<[LogEntry], void>()
    const log = new EventRunLogger('run-1', sink)

    log.info('starting', { stage: 'topic-scout' })
    log.warn('slow')
    log.error('failed')

    expect(sink).toHaveBeenCalledTimes(3)
    expect(sink.mock.calls[0]![0]).toMatchObject({
      runId: 'run-1',
      level: 'info',
      message: 'starting',
      meta: { stage: 'topic-scout' },
    })
    expect(sink.mock.calls[1]![0]!.level).toBe('warn')
    expect(sink.mock.calls[2]![0]!.level).toBe('error')
  })

  it('never throws when the sink throws, so logging cannot fail a run', () => {
    const log = new EventRunLogger('run-1', () => {
      throw new Error('SSE client vanished')
    })
    expect(() => log.info('still fine')).not.toThrow()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/pipeline/src/storage packages/pipeline/src/logger.test.ts`
Expected: FAIL — `runPaths`, `FileArtifactStore`, and `EventRunLogger` are not exported.

- [ ] **Step 3: Write the implementation**

Create `packages/pipeline/src/storage/paths.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import type { RunPaths } from '@yt/core'

/** One self-contained, hand-inspectable directory per run. See spec section 3. */
export const runPaths = (storageRoot: string, runId: string): RunPaths => {
  const root = path.resolve(storageRoot, 'videos', runId)
  return {
    root,
    audio: path.join(root, 'audio'),
    images: path.join(root, 'images'),
    clipsInbox: path.join(root, 'clips', 'inbox'),
    clipsNormalised: path.join(root, 'clips', 'normalised'),
    captions: path.join(root, 'captions'),
    thumbnail: path.join(root, 'thumbnail'),
    out: path.join(root, 'out'),
  }
}

export const ensureRunDirs = async (paths: RunPaths): Promise<void> => {
  for (const dir of [
    paths.root,
    paths.audio,
    paths.images,
    paths.clipsInbox,
    paths.clipsNormalised,
    paths.captions,
    paths.thumbnail,
    paths.out,
  ]) {
    await fs.mkdir(dir, { recursive: true })
  }
}
```

Create `packages/pipeline/src/storage/artifacts.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import type { z } from 'zod'
import type { ArtifactName, ArtifactStore, RunPaths } from '@yt/core'

/**
 * Artifacts are validated on the way in and on the way out. A stage can therefore trust
 * that any artifact it reads matches its schema, which is what makes resuming safe.
 */
export class FileArtifactStore implements ArtifactStore {
  constructor(private readonly paths: RunPaths) {}

  private file(name: ArtifactName): string {
    return path.join(this.paths.root, `${name}.json`)
  }

  async write<T>(name: ArtifactName, schema: z.ZodType<T>, data: T): Promise<void> {
    const parsed = schema.safeParse(data)
    if (!parsed.success) {
      throw new Error(
        `artifact '${name}' failed validation on write: ${JSON.stringify(parsed.error.issues)}`,
      )
    }
    await fs.mkdir(this.paths.root, { recursive: true })
    await fs.writeFile(this.file(name), `${JSON.stringify(parsed.data, null, 2)}\n`, 'utf8')
  }

  async read<T>(name: ArtifactName, schema: z.ZodType<T>): Promise<T> {
    let raw: string
    try {
      raw = await fs.readFile(this.file(name), 'utf8')
    } catch {
      throw new Error(`artifact '${name}' not found at ${this.file(name)}`)
    }

    const parsed = schema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      throw new Error(
        `artifact '${name}' failed validation on read: ${JSON.stringify(parsed.error.issues)}`,
      )
    }
    return parsed.data
  }

  async exists(name: ArtifactName): Promise<boolean> {
    try {
      await fs.access(this.file(name))
      return true
    } catch {
      return false
    }
  }
}
```

Create `packages/pipeline/src/logger.ts`:

```ts
import type { RunLogger } from '@yt/core'

export interface LogEntry {
  runId: string
  level: 'info' | 'warn' | 'error'
  message: string
  meta?: Record<string, unknown>
}

/**
 * Emits structured entries to a sink, which the API layer forwards over SSE so the
 * dashboard shows live progress instead of a spinner. A failing sink must never fail a run.
 */
export class EventRunLogger implements RunLogger {
  constructor(
    private readonly runId: string,
    private readonly sink: (entry: LogEntry) => void,
  ) {}

  private emit(level: LogEntry['level'], message: string, meta?: Record<string, unknown>): void {
    try {
      this.sink({ runId: this.runId, level, message, ...(meta ? { meta } : {}) })
    } catch {
      // Swallowed deliberately: a disconnected log consumer must not abort the pipeline.
    }
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.emit('info', message, meta)
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.emit('warn', message, meta)
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.emit('error', message, meta)
  }
}
```

Append to `packages/pipeline/src/index.ts`:

```ts
export * from './storage/paths'
export * from './storage/artifacts'
export * from './logger'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — 11 new tests (3 paths, 6 artifacts, 2 logger); whole suite green.

- [ ] **Step 5: Commit**

```bash
git add packages/pipeline/src
git commit -m "feat(pipeline): add run storage layout, validated artifact store and event logger"
```

---

### Task 11: Retry policy and StageRunner

The orchestration core. It is tested entirely against fake stages, so it never depends on any AI model.

**Files:**
- Create: `packages/pipeline/src/retry.ts`, `packages/pipeline/src/stage-runner.ts`
- Create: `test/fixtures/stages.ts`
- Modify: `packages/pipeline/src/index.ts`
- Test: `packages/pipeline/src/retry.test.ts`, `packages/pipeline/src/stage-runner.test.ts`

**Interfaces:**
- Consumes: `Stage`, `StageOutcome`, `RunContext` (Task 5); `ModelBroker` (Task 8); `Repositories` (Task 7); `RetryConfig` (Task 4)
- Produces:
  - `attemptsFor(stage: Stage, retries: RetryConfig): number`
  - `class StageRunner` — `constructor(deps: { stages: Stage[]; broker: ModelBroker; repos: Repositories; clock: Clock })`, `execute(ctx: RunContext): Promise<RunResult>`
  - `type RunResult = { status: RunStatus; stoppedAt?: StageName; reason?: string }`
  - Fixture `fakeStage(name, opts?)`

- [ ] **Step 1: Write the failing tests**

Create `test/fixtures/stages.ts`:

```ts
import { STAGE_REQUIREMENTS, type Stage, type StageName, type StageOutcome } from '@yt/core'

export interface FakeStageOptions {
  outcome?: StageOutcome
  /** Throw on the first N invocations, then succeed. Exercises retry behaviour. */
  failTimes?: number
  onRun?: (name: StageName) => void
}

export const fakeStage = (name: StageName, opts: FakeStageOptions = {}): Stage => {
  let invocations = 0
  return {
    name,
    requires: STAGE_REQUIREMENTS[name],
    async run() {
      invocations += 1
      opts.onRun?.(name)
      if (opts.failTimes && invocations <= opts.failTimes) {
        throw new Error(`${name} failed on attempt ${invocations}`)
      }
      return opts.outcome ?? { status: 'done' }
    },
  }
}
```

Create `packages/pipeline/src/retry.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG } from '@yt/core'
import { attemptsFor } from '@yt/pipeline'
import { fakeStage } from '../../../test/fixtures/stages'

const retries = DEFAULT_APP_CONFIG.retries

describe('attemptsFor', () => {
  it('gives LLM stages three attempts', () => {
    expect(attemptsFor(fakeStage('script-writer'), retries)).toBe(3)
  })

  it('gives network stages three attempts', () => {
    expect(attemptsFor(fakeStage('publisher'), retries)).toBe(3)
  })

  it('gives the render stage a single attempt', () => {
    expect(attemptsFor(fakeStage('editor'), retries)).toBe(1)
  })

  it('gives local stages a single attempt', () => {
    expect(attemptsFor(fakeStage('narrator'), retries)).toBe(1)
  })
})
```

Create `packages/pipeline/src/stage-runner.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG, FORMAT_PRESETS, STAGE_NAMES, type RunContext } from '@yt/core'
import { createFakeProviders, FixedClock } from '@yt/providers'
import type { Repositories } from '@yt/db'
import { EventRunLogger, ModelBroker, StageRunner, type Evictable } from '@yt/pipeline'
import { createTestDb } from '../../../test/setup/db'
import { fakeStage } from '../../../test/fixtures/stages'

let repos: Repositories
let cleanup: () => Promise<void>
let broker: ModelBroker
let unloaded: string[]

const niche = {
  id: 'space',
  label: 'Space',
  promptGuidance: 'Explain one cosmic phenomenon.',
  voice: 'male',
  styleSuffix: 'cinematic',
  music: 'ambient-drone',
  trendSources: ['wikipedia-top'] as const,
  seoRules: 'Lead with the object.',
  monetizationRisk: 'low' as const,
}

const evictable = (id: 'llm' | 'sd'): Evictable => ({
  id,
  unload: async () => {
    unloaded.push(id)
  },
})

const context = (): RunContext =>
  ({
    runId: 'run-1',
    config: { ...DEFAULT_APP_CONFIG, nicheConfig: niche, preset: FORMAT_PRESETS.long },
    paths: {} as RunContext['paths'],
    artifacts: {} as RunContext['artifacts'],
    topics: repos.topics,
    clipRequests: repos.clips,
    providers: createFakeProviders(),
    log: new EventRunLogger('run-1', () => {}),
    clock: new FixedClock('2026-08-01T10:00:00.000Z'),
  }) as RunContext

const runner = (stages: ReturnType<typeof fakeStage>[]) =>
  new StageRunner({
    stages,
    broker,
    repos,
    clock: new FixedClock('2026-08-01T10:00:00.000Z'),
  })

beforeEach(async () => {
  const db = await createTestDb()
  repos = db.repos
  cleanup = db.cleanup
  unloaded = []
  broker = new ModelBroker([evictable('llm'), evictable('sd')])
  await repos.runs.create({
    id: 'run-1',
    niche: 'space',
    format: 'long',
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
  })
})

afterEach(async () => {
  await cleanup()
})

describe('StageRunner', () => {
  it('runs every stage in order', async () => {
    const order: string[] = []
    const stages = STAGE_NAMES.map((n) => fakeStage(n, { onRun: (name) => order.push(name) }))

    const result = await runner(stages).execute(context())

    expect(result.status).toBe('awaiting_review')
    expect(order).toEqual([...STAGE_NAMES])
  })

  it('records every stage as completed', async () => {
    await runner(STAGE_NAMES.map((n) => fakeStage(n))).execute(context())
    expect(await repos.runs.completedStages('run-1')).toEqual([...STAGE_NAMES])
  })

  it('evicts models exactly twice across a full run', async () => {
    await runner(STAGE_NAMES.map((n) => fakeStage(n))).execute(context())
    // llm evicted when the SD block begins; sd evicted by the final evictAll.
    expect(unloaded).toEqual(['llm', 'sd'])
  })

  it('retries a failing LLM stage up to its attempt limit and then succeeds', async () => {
    const stages = STAGE_NAMES.map((n) =>
      n === 'script-writer' ? fakeStage(n, { failTimes: 2 }) : fakeStage(n),
    )

    const result = await runner(stages).execute(context())

    expect(result.status).toBe('awaiting_review')
    const recorded = (await repos.runs.stages('run-1')).find((s) => s.name === 'script-writer')
    expect(recorded).toMatchObject({ status: 'done', attempts: 3 })
  })

  it('fails the run when a stage exhausts its attempts', async () => {
    const stages = STAGE_NAMES.map((n) =>
      n === 'script-writer' ? fakeStage(n, { failTimes: 99 }) : fakeStage(n),
    )

    const result = await runner(stages).execute(context())

    expect(result).toMatchObject({ status: 'failed', stoppedAt: 'script-writer' })
    expect(result.reason).toContain('script-writer failed')
    expect((await repos.runs.get('run-1'))!.status).toBe('failed')
  })

  it('does not run stages after a failure', async () => {
    const order: string[] = []
    const stages = STAGE_NAMES.map((n) =>
      n === 'researcher'
        ? fakeStage(n, { failTimes: 99, onRun: (name) => order.push(name) })
        : fakeStage(n, { onRun: (name) => order.push(name) }),
    )

    await runner(stages).execute(context())

    expect(order).not.toContain('script-writer')
  })

  it('resumes from the last completed stage instead of restarting', async () => {
    const first = STAGE_NAMES.map((n) =>
      n === 'seo' ? fakeStage(n, { failTimes: 99 }) : fakeStage(n),
    )
    await runner(first).execute(context())

    const order: string[] = []
    const second = STAGE_NAMES.map((n) => fakeStage(n, { onRun: (name) => order.push(name) }))
    const result = await runner(second).execute(context())

    expect(result.status).toBe('awaiting_review')
    expect(order[0]).toBe('seo')
    expect(order).not.toContain('topic-scout')
  })

  it('pauses the run when the clip gate asks for human input', async () => {
    const order: string[] = []
    const stages = STAGE_NAMES.map((n) =>
      n === 'clip-gate'
        ? fakeStage(n, {
            outcome: { status: 'paused', reason: 'awaiting_clips' },
            onRun: (name) => order.push(name),
          })
        : fakeStage(n, { onRun: (name) => order.push(name) }),
    )

    const result = await runner(stages).execute(context())

    expect(result).toMatchObject({ status: 'awaiting_clips', stoppedAt: 'clip-gate' })
    expect((await repos.runs.get('run-1'))!.status).toBe('awaiting_clips')
    expect(order).not.toContain('editor')
  })

  it('re-runs the paused stage on resume rather than skipping it', async () => {
    const paused = STAGE_NAMES.map((n) =>
      n === 'clip-gate'
        ? fakeStage(n, { outcome: { status: 'paused', reason: 'awaiting_clips' } })
        : fakeStage(n),
    )
    await runner(paused).execute(context())

    const order: string[] = []
    const resumed = STAGE_NAMES.map((n) => fakeStage(n, { onRun: (name) => order.push(name) }))
    const result = await runner(resumed).execute(context())

    expect(order[0]).toBe('clip-gate')
    expect(result.status).toBe('awaiting_review')
  })

  it('halts the run with a readable reason when a gate rejects it', async () => {
    const stages = STAGE_NAMES.map((n) =>
      n === 'quality-gate'
        ? fakeStage(n, { outcome: { status: 'halted', reason: 'audio and video durations differ by 9%' } })
        : fakeStage(n),
    )

    const result = await runner(stages).execute(context())

    expect(result).toMatchObject({
      status: 'failed',
      stoppedAt: 'quality-gate',
      reason: 'audio and video durations differ by 9%',
    })
  })

  it('frees all model memory even when a stage fails', async () => {
    const stages = STAGE_NAMES.map((n) =>
      n === 'illustrator' ? fakeStage(n, { failTimes: 99 }) : fakeStage(n),
    )

    await runner(stages).execute(context())

    expect(unloaded).toContain('sd')
    expect(broker.resident).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/pipeline/src/stage-runner.test.ts`
Expected: FAIL — `StageRunner` and `attemptsFor` are not exported.

- [ ] **Step 3: Write the retry policy**

Create `packages/pipeline/src/retry.ts`:

```ts
import { STAGE_RETRY_KIND, type RetryConfig, type Stage } from '@yt/core'

/** Attempt budget per stage, derived from its retry kind. See spec section 8. */
export const attemptsFor = (stage: Stage, retries: RetryConfig): number =>
  retries[STAGE_RETRY_KIND[stage.name]]
```

- [ ] **Step 4: Write the StageRunner**

Create `packages/pipeline/src/stage-runner.ts`:

```ts
import type { Clock, RunContext, RunStatus, Stage, StageName } from '@yt/core'
import type { Repositories } from '@yt/db'
import { ModelBroker } from './model-broker'
import { attemptsFor } from './retry'

export interface StageRunnerDeps {
  stages: Stage[]
  broker: ModelBroker
  repos: Repositories
  clock: Clock
}

export interface RunResult {
  status: RunStatus
  stoppedAt?: StageName
  reason?: string
}

export class StageRunner {
  constructor(private readonly deps: StageRunnerDeps) {}

  async execute(ctx: RunContext): Promise<RunResult> {
    const { stages, broker, repos, clock } = this.deps
    const completed = new Set(await repos.runs.completedStages(ctx.runId))

    await repos.runs.setStatus(ctx.runId, 'running')

    try {
      for (const stage of stages) {
        if (completed.has(stage.name)) {
          ctx.log.info(`skipping ${stage.name}, already completed`, { stage: stage.name })
          continue
        }

        const outcome = await this.runWithRetry(ctx, stage)

        if (outcome.kind === 'failed') {
          await repos.runs.setStatus(ctx.runId, 'failed')
          return { status: 'failed', stoppedAt: stage.name, reason: outcome.reason }
        }

        if (outcome.kind === 'halted') {
          await repos.runs.setStatus(ctx.runId, 'failed')
          return { status: 'failed', stoppedAt: stage.name, reason: outcome.reason }
        }

        if (outcome.kind === 'paused') {
          // Deliberately not marked done: the stage re-runs on resume to collect the
          // assets the human supplied while the run was paused.
          await repos.runs.setStatus(ctx.runId, 'awaiting_clips')
          ctx.log.info(`paused awaiting human input`, { stage: stage.name })
          return { status: 'awaiting_clips', stoppedAt: stage.name }
        }

        await repos.runs.finishStage(ctx.runId, stage.name, clock.now())
        ctx.log.info(`completed ${stage.name}`, { stage: stage.name })
      }

      await repos.runs.setStatus(ctx.runId, 'awaiting_review')
      return { status: 'awaiting_review' }
    } finally {
      // Always give the memory back, however the run ended.
      await broker.evictAll()
    }
  }

  private async runWithRetry(
    ctx: RunContext,
    stage: Stage,
  ): Promise<
    | { kind: 'done' }
    | { kind: 'paused' }
    | { kind: 'halted'; reason: string }
    | { kind: 'failed'; reason: string }
  > {
    const { broker, repos, clock } = this.deps
    const maxAttempts = attemptsFor(stage, ctx.config.retries)
    let lastError = 'unknown error'

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await repos.runs.startStage(ctx.runId, stage.name, clock.now())
      const lease = await broker.acquire(stage.requires)

      try {
        const outcome = await stage.run(ctx)
        if (outcome.status === 'paused') return { kind: 'paused' }
        if (outcome.status === 'halted') {
          await repos.runs.failStage(ctx.runId, stage.name, outcome.reason, clock.now())
          return { kind: 'halted', reason: outcome.reason }
        }
        return { kind: 'done' }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        ctx.log.warn(`${stage.name} attempt ${attempt}/${maxAttempts} failed: ${lastError}`, {
          stage: stage.name,
          attempt,
        })
        await repos.runs.failStage(ctx.runId, stage.name, lastError, clock.now())
      } finally {
        lease.release()
      }
    }

    return { kind: 'failed', reason: `${stage.name} failed after ${maxAttempts} attempts: ${lastError}` }
  }
}
```

Append to `packages/pipeline/src/index.ts`:

```ts
export * from './retry'
export * from './stage-runner'
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — 15 new tests (4 retry policy, 11 stage runner); whole suite green.

- [ ] **Step 6: Commit**

```bash
git add packages/pipeline/src test/fixtures
git commit -m "feat(pipeline): add StageRunner with retry, resume, pause and halt semantics"
```

---

### Task 12: Job worker

**Files:**
- Create: `packages/pipeline/src/job-worker.ts`
- Modify: `packages/pipeline/src/index.ts`
- Test: `packages/pipeline/src/job-worker.test.ts`

**Interfaces:**
- Consumes: `JobRepository`, `ClaimedJob` (Task 7); `Clock` (Task 5)
- Produces:
  - `class JobWorker` — `constructor(deps: { repos: Repositories; clock: Clock; maxAttempts?: number; handler: (job: ClaimedJob) => Promise<void> })`, `tick(): Promise<boolean>`, `drain(): Promise<number>`

- [ ] **Step 1: Write the failing test**

Create `packages/pipeline/src/job-worker.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FixedClock } from '@yt/providers'
import type { Repositories } from '@yt/db'
import { JobWorker } from '@yt/pipeline'
import { createTestDb } from '../../../test/setup/db'

let repos: Repositories
let cleanup: () => Promise<void>
const clock = () => new FixedClock('2026-08-01T10:00:00.000Z')

beforeEach(async () => {
  const db = await createTestDb()
  repos = db.repos
  cleanup = db.cleanup
})

afterEach(async () => {
  await cleanup()
})

describe('JobWorker', () => {
  it('reports no work when the queue is empty', async () => {
    const worker = new JobWorker({ repos, clock: clock(), handler: async () => {} })
    expect(await worker.tick()).toBe(false)
  })

  it('processes a queued job and marks it done', async () => {
    const handler = vi.fn(async () => {})
    await repos.jobs.enqueue('generate', { runId: 'run-1' }, new Date('2026-08-01T10:00:00.000Z'))

    const worker = new JobWorker({ repos, clock: clock(), handler })
    expect(await worker.tick()).toBe(true)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]![0]).toMatchObject({ type: 'generate', payload: { runId: 'run-1' } })
    expect(await worker.tick()).toBe(false)
  })

  it('processes jobs one at a time in enqueue order', async () => {
    const seen: string[] = []
    for (const id of ['a', 'b', 'c']) {
      await repos.jobs.enqueue('generate', { runId: id }, new Date('2026-08-01T10:00:00.000Z'))
    }

    const worker = new JobWorker({
      repos,
      clock: clock(),
      handler: async (job) => {
        seen.push(String(job.payload.runId))
      },
    })
    const processed = await worker.drain()

    expect(processed).toBe(3)
    expect(seen).toEqual(['a', 'b', 'c'])
  })

  it('requeues a throwing job until the attempt limit', async () => {
    await repos.jobs.enqueue('generate', { runId: 'run-1' }, new Date('2026-08-01T10:00:00.000Z'))
    const handler = vi.fn(async () => {
      throw new Error('stage exploded')
    })

    const worker = new JobWorker({ repos, clock: clock(), maxAttempts: 2, handler })
    await worker.drain()

    expect(handler).toHaveBeenCalledTimes(2)
    expect(await worker.tick()).toBe(false)
  })

  it('does not let a handler failure escape the worker', async () => {
    await repos.jobs.enqueue('generate', {}, new Date('2026-08-01T10:00:00.000Z'))
    const worker = new JobWorker({
      repos,
      clock: clock(),
      maxAttempts: 1,
      handler: async () => {
        throw new Error('boom')
      },
    })

    await expect(worker.tick()).resolves.toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/pipeline/src/job-worker.test.ts`
Expected: FAIL — `JobWorker` is not exported.

- [ ] **Step 3: Write the implementation**

Create `packages/pipeline/src/job-worker.ts`:

```ts
import type { Clock } from '@yt/core'
import type { ClaimedJob, Repositories } from '@yt/db'

export interface JobWorkerDeps {
  repos: Repositories
  clock: Clock
  /** Concurrency is fixed at 1: the memory constraint makes parallel runs impossible. */
  maxAttempts?: number
  handler: (job: ClaimedJob) => Promise<void>
}

export class JobWorker {
  private readonly maxAttempts: number

  constructor(private readonly deps: JobWorkerDeps) {
    this.maxAttempts = deps.maxAttempts ?? 3
  }

  /** Processes at most one job. Returns false when the queue is empty. */
  async tick(): Promise<boolean> {
    const { repos, clock, handler } = this.deps
    const job = await repos.jobs.claimNext(clock.now())
    if (!job) return false

    try {
      await handler(job)
      await repos.jobs.complete(job.id, clock.now())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await repos.jobs.fail(job.id, message, this.maxAttempts, clock.now())
    }
    return true
  }

  /** Drains the queue, including retries. Returns the number of jobs processed. */
  async drain(): Promise<number> {
    let processed = 0
    while (await this.tick()) processed += 1
    return processed
  }
}
```

Append to `packages/pipeline/src/index.ts`:

```ts
export * from './job-worker'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — 5 new worker tests; whole suite green.

- [ ] **Step 5: Commit**

```bash
git add packages/pipeline/src
git commit -m "feat(pipeline): add SQLite-backed job worker at concurrency one"
```

---

### Task 13: Doctor checks

Verifies the machine can actually run the pipeline. Every check is injected, so the tests never touch the real filesystem or shell.

**Files:**
- Create: `packages/pipeline/src/doctor.ts`
- Modify: `packages/pipeline/src/index.ts`
- Test: `packages/pipeline/src/doctor.test.ts`

**Interfaces:**
- Produces:
  - `interface CommandRunner { which(bin: string): Promise<string | null> }`
  - `interface FsProbe { exists(p: string): Promise<boolean>; freeBytes(p: string): Promise<number> }`
  - `buildDefaultChecks(deps: { cmd: CommandRunner; fs: FsProbe; repoRoot: string }): DoctorCheck[]`
  - `runDoctor(checks: DoctorCheck[]): Promise<DoctorReport>`
  - `type DoctorCheck = { name: string; required: boolean; run(): Promise<{ ok: boolean; detail: string }> }`
  - `type DoctorReport = { ok: boolean; results: Array<{ name; required; ok; detail }> }`
  - `nodeCommandRunner()`, `nodeFsProbe()` — real implementations used by the CLI

- [ ] **Step 1: Write the failing test**

Create `packages/pipeline/src/doctor.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildDefaultChecks, runDoctor, type CommandRunner, type FsProbe } from '@yt/pipeline'

const cmd = (present: string[]): CommandRunner => ({
  async which(bin) {
    return present.includes(bin) ? `/usr/local/bin/${bin}` : null
  },
})

const probe = (existing: string[], free = 100 * 1024 ** 3): FsProbe => ({
  async exists(p) {
    return existing.some((e) => p.endsWith(e))
  },
  async freeBytes() {
    return free
  },
})

const allPresent = () =>
  buildDefaultChecks({
    cmd: cmd(['ffmpeg', 'whisper-cli', 'node', 'python3']),
    fs: probe(['bin/ollama', 'models/ollama', 'models/hf', 'models/tts', 'models/whisper']),
    repoRoot: '/repo',
  })

describe('doctor', () => {
  it('passes when every dependency is present', async () => {
    const report = await runDoctor(allPresent())
    expect(report.ok).toBe(true)
    expect(report.results.every((r) => r.ok)).toBe(true)
  })

  it('fails when ffmpeg is missing', async () => {
    const checks = buildDefaultChecks({
      cmd: cmd(['whisper-cli', 'node', 'python3']),
      fs: probe(['bin/ollama']),
      repoRoot: '/repo',
    })
    const report = await runDoctor(checks)

    expect(report.ok).toBe(false)
    expect(report.results.find((r) => r.name === 'ffmpeg')).toMatchObject({ ok: false })
  })

  it('fails when the in-repo ollama binary is absent', async () => {
    const checks = buildDefaultChecks({
      cmd: cmd(['ffmpeg', 'whisper-cli', 'node', 'python3']),
      fs: probe([]),
      repoRoot: '/repo',
    })
    const report = await runDoctor(checks)

    expect(report.results.find((r) => r.name === 'ollama binary')).toMatchObject({ ok: false })
  })

  it('reports missing model directories without failing the whole report', async () => {
    const checks = buildDefaultChecks({
      cmd: cmd(['ffmpeg', 'whisper-cli', 'node', 'python3']),
      fs: probe(['bin/ollama']),
      repoRoot: '/repo',
    })
    const report = await runDoctor(checks)

    const weights = report.results.find((r) => r.name === 'SDXL weights')
    expect(weights).toMatchObject({ ok: false, required: false })
  })

  it('fails when free disk space is below twenty gigabytes', async () => {
    const checks = buildDefaultChecks({
      cmd: cmd(['ffmpeg', 'whisper-cli', 'node', 'python3']),
      fs: probe(['bin/ollama', 'models/ollama', 'models/hf', 'models/tts', 'models/whisper'], 5 * 1024 ** 3),
      repoRoot: '/repo',
    })
    const report = await runDoctor(checks)

    expect(report.results.find((r) => r.name === 'disk space')).toMatchObject({ ok: false })
    expect(report.ok).toBe(false)
  })

  it('surfaces a thrown check as a failure rather than crashing', async () => {
    const report = await runDoctor([
      {
        name: 'explodes',
        required: true,
        run: async () => {
          throw new Error('permission denied')
        },
      },
    ])

    expect(report.ok).toBe(false)
    expect(report.results[0]!.detail).toContain('permission denied')
  })

  it('ignores optional failures when deciding overall status', async () => {
    const report = await runDoctor([
      { name: 'required-ok', required: true, run: async () => ({ ok: true, detail: 'fine' }) },
      { name: 'optional-bad', required: false, run: async () => ({ ok: false, detail: 'absent' }) },
    ])

    expect(report.ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/pipeline/src/doctor.test.ts`
Expected: FAIL — `buildDefaultChecks` is not exported.

- [ ] **Step 3: Write the implementation**

Create `packages/pipeline/src/doctor.ts`:

```ts
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface CommandRunner {
  which(bin: string): Promise<string | null>
}

export interface FsProbe {
  exists(p: string): Promise<boolean>
  freeBytes(p: string): Promise<number>
}

export interface DoctorCheck {
  name: string
  /** Optional checks report status but do not fail the overall report. */
  required: boolean
  run(): Promise<{ ok: boolean; detail: string }>
}

export interface DoctorReport {
  ok: boolean
  results: Array<{ name: string; required: boolean; ok: boolean; detail: string }>
}

/** 20 GB covers the model downloads plus render working space. */
export const MIN_FREE_BYTES = 20 * 1024 ** 3

export const buildDefaultChecks = (deps: {
  cmd: CommandRunner
  fs: FsProbe
  repoRoot: string
}): DoctorCheck[] => {
  const { cmd, fs, repoRoot } = deps

  const binary = (bin: string, required = true): DoctorCheck => ({
    name: bin,
    required,
    run: async () => {
      const found = await cmd.which(bin)
      return found
        ? { ok: true, detail: found }
        : { ok: false, detail: `${bin} not found on PATH` }
    },
  })

  const repoPath = (relative: string, name: string, required: boolean): DoctorCheck => ({
    name,
    required,
    run: async () => {
      const target = path.join(repoRoot, relative)
      const present = await fs.exists(target)
      return present
        ? { ok: true, detail: target }
        : { ok: false, detail: `missing ${target} — run the setup script for this component` }
    },
  })

  return [
    binary('node'),
    binary('python3'),
    binary('ffmpeg'),
    binary('whisper-cli'),
    repoPath('bin/ollama', 'ollama binary', true),
    repoPath('models/ollama', 'LLM weights', false),
    repoPath('models/hf', 'SDXL weights', false),
    repoPath('models/tts', 'TTS voice', false),
    repoPath('models/whisper', 'whisper model', false),
    {
      name: 'disk space',
      required: true,
      run: async () => {
        const free = await fs.freeBytes(repoRoot)
        const gb = (free / 1024 ** 3).toFixed(1)
        return free >= MIN_FREE_BYTES
          ? { ok: true, detail: `${gb} GB free` }
          : { ok: false, detail: `only ${gb} GB free, need at least 20 GB` }
      },
    },
  ]
}

export const runDoctor = async (checks: DoctorCheck[]): Promise<DoctorReport> => {
  const results: DoctorReport['results'] = []

  for (const check of checks) {
    try {
      const outcome = await check.run()
      results.push({ name: check.name, required: check.required, ...outcome })
    } catch (error) {
      results.push({
        name: check.name,
        required: check.required,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { ok: results.every((r) => r.ok || !r.required), results }
}

export const nodeCommandRunner = (): CommandRunner => ({
  async which(bin) {
    try {
      const { stdout } = await execFileAsync('which', [bin])
      const found = stdout.trim()
      return found.length > 0 ? found : null
    } catch {
      return null
    }
  },
})

export const nodeFsProbe = (): FsProbe => ({
  async exists(p) {
    try {
      await fsp.access(p)
      return true
    } catch {
      return false
    }
  },
  async freeBytes(p) {
    const stats = await fsp.statfs(p)
    return Number(stats.bavail) * Number(stats.bsize)
  },
})
```

Append to `packages/pipeline/src/index.ts`:

```ts
export * from './doctor'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — 7 new doctor tests; whole suite green.

- [ ] **Step 5: Commit**

```bash
git add packages/pipeline/src
git commit -m "feat(pipeline): add doctor checks for binaries, weights and disk space"
```

---

### Task 14: CLI and the end-to-end fake pipeline run

The payoff task. After this, the whole fourteen-stage pipeline runs from the command line in seconds, with no model loaded, proving the engine before any real provider exists.

**Files:**
- Create: `packages/pipeline/src/cli.ts`
- Create: `packages/pipeline/src/testing/noop-stages.ts`
- Modify: `packages/pipeline/src/index.ts`
- Test: `test/e2e/fake-pipeline.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5–13
- Produces:
  - `buildNoopStages(): Stage[]` — one artifact-writing placeholder per stage name, replaced by real stages in Plans 2–4
  - `runPipeline(opts): Promise<RunResult>` — the composition root
  - CLI verbs `run` and `doctor`

- [ ] **Step 1: Write the failing test**

Create `test/e2e/fake-pipeline.test.ts`:

```ts
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STAGE_NAMES } from '@yt/core'
import type { Repositories } from '@yt/db'
import { runPipeline } from '@yt/pipeline'
import { createTestDb } from '../setup/db'

let repos: Repositories
let cleanup: () => Promise<void>
let storageRoot: string

const configDir = path.resolve(__dirname, '../../config')

beforeEach(async () => {
  const db = await createTestDb()
  repos = db.repos
  cleanup = db.cleanup
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-e2e-'))
})

afterEach(async () => {
  await cleanup()
  await fs.rm(storageRoot, { recursive: true, force: true })
})

describe('end-to-end pipeline with fakes', () => {
  it('runs all fourteen stages and reaches review', async () => {
    const result = await runPipeline({
      runId: 'run-e2e',
      repos,
      configDir,
      storageRoot,
      request: { niche: 'space', videoType: 'shorts', clips: undefined },
      useFakes: true,
    })

    expect(result.status).toBe('awaiting_review')
    expect(await repos.runs.completedStages('run-e2e')).toEqual([...STAGE_NAMES])
  })

  it('creates the per-run storage layout', async () => {
    await runPipeline({
      runId: 'run-e2e',
      repos,
      configDir,
      storageRoot,
      request: { niche: 'space', videoType: 'shorts' },
      useFakes: true,
    })

    const root = path.join(storageRoot, 'videos', 'run-e2e')
    for (const dir of ['audio', 'images', 'captions', 'thumbnail', 'out', 'clips/inbox']) {
      expect((await fs.stat(path.join(root, dir))).isDirectory()).toBe(true)
    }
  })

  it('completes in a few seconds because no model is loaded', async () => {
    const started = process.hrtime.bigint()
    await runPipeline({
      runId: 'run-e2e',
      repos,
      configDir,
      storageRoot,
      request: { niche: 'space', videoType: 'shorts' },
      useFakes: true,
    })
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

    expect(elapsedMs).toBeLessThan(5000)
  })

  it('streams a log entry for every stage', async () => {
    const messages: string[] = []
    await runPipeline({
      runId: 'run-e2e',
      repos,
      configDir,
      storageRoot,
      request: { niche: 'space', videoType: 'shorts' },
      useFakes: true,
      onLog: (entry) => messages.push(entry.message),
    })

    for (const name of STAGE_NAMES) {
      expect(messages.some((m) => m.includes(name))).toBe(true)
    }
  })

  it('resumes a killed run from the last completed stage', async () => {
    // Simulate a run that already got through the LLM block.
    await repos.runs.create({
      id: 'run-resume',
      niche: 'space',
      format: 'shorts',
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
    })
    for (const name of ['topic-scout', 'researcher', 'script-writer'] as const) {
      await repos.runs.startStage('run-resume', name, new Date('2026-08-01T10:00:00.000Z'))
      await repos.runs.finishStage('run-resume', name, new Date('2026-08-01T10:00:01.000Z'))
    }

    const messages: string[] = []
    const result = await runPipeline({
      runId: 'run-resume',
      repos,
      configDir,
      storageRoot,
      request: { niche: 'space', videoType: 'shorts' },
      useFakes: true,
      onLog: (entry) => messages.push(entry.message),
    })

    expect(result.status).toBe('awaiting_review')
    expect(messages).toContain('skipping topic-scout, already completed')
    expect(messages).not.toContain('completed topic-scout')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/e2e/fake-pipeline.test.ts`
Expected: FAIL — `runPipeline` is not exported.

- [ ] **Step 3: Write the placeholder stages**

These exist only so the engine has fourteen real stages to drive. Plans 2–4 replace them one at a time; each replacement is a drop-in because the `Stage` interface does not change.

Create `packages/pipeline/src/testing/noop-stages.ts`:

```ts
import { STAGE_NAMES, STAGE_REQUIREMENTS, type Stage } from '@yt/core'

/**
 * Placeholder stages that satisfy the Stage contract without doing real work.
 * Replaced stage-by-stage in Plans 2-4. Kept in src (not test) so the CLI can run
 * a smoke pipeline before any real provider exists.
 */
export const buildNoopStages = (): Stage[] =>
  STAGE_NAMES.map((name) => ({
    name,
    requires: STAGE_REQUIREMENTS[name],
    async run(ctx) {
      ctx.log.info(`noop ${name}`, { stage: name })
      return { status: 'done' as const }
    },
  }))
```

- [ ] **Step 4: Write the composition root and CLI**

Create `packages/pipeline/src/cli.ts`:

```ts
import path from 'node:path'
import type { AppConfig, ProviderBundle, RunContext, Stage } from '@yt/core'
import { createRepositories, createPrismaClient, type Repositories } from '@yt/db'
import { createFakeProviders, FixedClock } from '@yt/providers'
import { loadConfig } from './config/load'
import {
  buildDefaultChecks,
  nodeCommandRunner,
  nodeFsProbe,
  runDoctor,
} from './doctor'
import { EventRunLogger, type LogEntry } from './logger'
import { ModelBroker, type Evictable } from './model-broker'
import { StageRunner, type RunResult } from './stage-runner'
import { FileArtifactStore } from './storage/artifacts'
import { ensureRunDirs, runPaths } from './storage/paths'
import { buildNoopStages } from './testing/noop-stages'

export interface RunPipelineOptions {
  runId: string
  repos: Repositories
  configDir: string
  storageRoot: string
  request?: Partial<AppConfig>
  /** Uses fake providers and placeholder stages. Real wiring arrives in Plans 2-4. */
  useFakes?: boolean
  stages?: Stage[]
  providers?: ProviderBundle
  onLog?: (entry: LogEntry) => void
  nowIso?: string
}

export const runPipeline = async (opts: RunPipelineOptions): Promise<RunResult> => {
  const config = await loadConfig({ configDir: opts.configDir, request: opts.request })
  const clock = new FixedClock(opts.nowIso ?? '2026-08-01T10:00:00.000Z')

  const existing = await opts.repos.runs.get(opts.runId)
  if (!existing) {
    await opts.repos.runs.create({
      id: opts.runId,
      niche: config.niche,
      format: config.videoType,
      createdAt: clock.now(),
    })
  }

  const paths = runPaths(opts.storageRoot, opts.runId)
  await ensureRunDirs(paths)

  // useFakes must be explicit: silently falling back to fakes would let a misconfigured
  // real run produce a fake video that looks genuine.
  if (!opts.providers && !opts.useFakes) {
    throw new Error(
      'runPipeline requires `providers`, or `useFakes: true` until Plan 2 wires real adapters',
    )
  }

  const providers = opts.providers ?? createFakeProviders()
  const stages = opts.stages ?? buildNoopStages()

  // The broker owns eviction; providers expose unload, never called by a stage.
  const evictables: Evictable[] = [
    { id: 'llm', unload: () => providers.llm.unload() },
    { id: 'sd', unload: () => providers.image.unload() },
  ]

  const ctx: RunContext = {
    runId: opts.runId,
    config,
    paths,
    artifacts: new FileArtifactStore(paths),
    topics: opts.repos.topics,
    clipRequests: opts.repos.clips,
    providers,
    log: new EventRunLogger(opts.runId, opts.onLog ?? (() => {})),
    clock,
  }

  const runner = new StageRunner({
    stages,
    broker: new ModelBroker(evictables),
    repos: opts.repos,
    clock,
  })

  return runner.execute(ctx)
}

const repoRoot = path.resolve(__dirname, '../../..')

const main = async () => {
  const verb = process.argv[2]

  if (verb === 'doctor') {
    const report = await runDoctor(
      buildDefaultChecks({ cmd: nodeCommandRunner(), fs: nodeFsProbe(), repoRoot }),
    )
    for (const r of report.results) {
      const mark = r.ok ? 'PASS' : r.required ? 'FAIL' : 'WARN'
      console.log(`${mark.padEnd(4)}  ${r.name.padEnd(18)}  ${r.detail}`)
    }
    console.log(report.ok ? '\nAll required checks passed.' : '\nRequired checks failed.')
    process.exit(report.ok ? 0 : 1)
  }

  if (verb === 'run') {
    const databaseUrl = process.env.DATABASE_URL ?? `file:${path.join(repoRoot, 'storage/factory.db')}`
    const prisma = createPrismaClient(databaseUrl)
    const runId = process.argv[3] ?? `run-${process.pid}`

    const result = await runPipeline({
      runId,
      repos: createRepositories(prisma),
      configDir: path.join(repoRoot, 'config'),
      storageRoot: process.env.STORAGE_ROOT ?? path.join(repoRoot, 'storage'),
      useFakes: true,
      onLog: (entry) => console.log(`[${entry.level}] ${entry.message}`),
    })

    console.log(`\nrun ${runId} finished with status: ${result.status}`)
    if (result.reason) console.log(`reason: ${result.reason}`)
    await prisma.$disconnect()
    process.exit(result.status === 'failed' ? 1 : 0)
  }

  console.error('usage: pipeline <run|doctor> [runId]')
  process.exit(2)
}

if (require.main === module) {
  void main()
}
```

Append to `packages/pipeline/src/index.ts`:

```ts
export * from './testing/noop-stages'
export { runPipeline, type RunPipelineOptions } from './cli'
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — 5 new end-to-end tests; whole suite green.

- [ ] **Step 6: Verify the CLI works for real**

Run: `pnpm doctor`
Expected: a table of checks. `node`, `python3`, `ffmpeg`, and `whisper-cli` PASS; `ollama binary` FAILs and the model directories WARN, because Plans 2–3 install them. Exit code 1 is correct at this point.

Run: `pnpm --filter @yt/db db:push && pnpm pipeline:run smoke-1`
Expected: fourteen `noop` log lines followed by `run smoke-1 finished with status: awaiting_review`, exit code 0.

Run it a second time: `pnpm pipeline:run smoke-1`
Expected: fourteen `skipping ... already completed` lines — proving resume works against the real database.

- [ ] **Step 7: Verify typecheck and full suite**

Run: `pnpm typecheck && pnpm test`
Expected: exit code 0, full suite passing.

- [ ] **Step 8: Commit**

```bash
git add packages/pipeline/src test/e2e
git commit -m "feat(pipeline): add composition root, CLI and end-to-end fake pipeline run"
```

---

## Plan 1 completion checklist

- [ ] `pnpm test` passes in seconds with zero models loaded (~127 tests)
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm doctor` prints a readable table and exits non-zero only for genuinely missing required dependencies
- [ ] `pnpm pipeline:run <id>` executes all fourteen stages and reports `awaiting_review`
- [ ] Re-running the same id skips completed stages, proving resume
- [ ] The ModelBroker test proves exactly two evictions across the stage sequence
- [ ] No stage or engine file imports a concrete provider
- [ ] No `Date.now()` or `new Date()` outside repository call sites that receive an injected date

## Deliberate coverage gaps

Two spec section 6 models get their tables here but no repository, because nothing in this
plan writes to them and an unused repository is untested code:

- `Asset` — written by the media stages in Plan 3
- `TitleCandidate` — written by the SEO stage in Plan 2, read by the dashboard in Plan 4

Their Prisma models exist now so the schema is stable and no migration is needed later.

## What Plan 2 consumes from this plan

Plan 2 (content generation) replaces the first six placeholder stages. It relies on:

- `Stage`, `StageOutcome`, `RunContext` — the contract each real stage implements
- `LlmProvider`, `TrendProvider` — the interfaces the Ollama and trend adapters satisfy
- `ResearchSchema`, `ScriptSchema`, `FactCheckSchema`, `ScenePlanSchema`, `SeoSchema` — validated artifact shapes
- `ArtifactStore` — where stages read and write
- `TopicStore` — permanent topic dedupe
- `ModelBroker` `Evictable` — the Ollama adapter supplies `unload()` via `keep_alive: 0`
- `runPipeline`'s `stages` and `providers` options — the injection points for real implementations
