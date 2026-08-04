# Plan 1 → Plan 2 Handoff

Plan 1 (foundation) is complete and merged. This file records what the final whole-branch
review found, so none of it is lost when the execution scratch workspace is deleted.

**State at handoff:** 24 commits, 160 tests passing in ~1.4s with zero AI models loaded,
`tsc --noEmit` clean. `pnpm pipeline:run <id>` executes all fourteen stages; re-running the
same id resumes instead of restarting. `pnpm check` runs the doctor preflight.

**Verified properties** (independently re-confirmed by the final review, not just by unit
tests):

- The two-models-swaps-per-run invariant holds through the **real CLI wiring**, not only in
  the broker's own unit test — measured `llmUnloads=1 sdUnloads=1`.
- `ModelBroker` and `StageRunner` genuinely compose: no lease leak or deadlock was
  constructible under any stage-outcome sequence.
- CLI exit codes: `0` success, `1` failed run, `1` doctor required-check failure,
  `2` unknown verb.

---

## Do these four things at the start of Plan 2

Ordered by when they hurt. None requires reworking the core machinery.

### 1. Add a real Clock and an injection point

`FixedClock` is currently the **only** `Clock` implementation, and `runPipeline` hardcodes it.
Every production run therefore stamps `2026-08-01T10:00:00Z` on every row, `startedAt` always
equals `endedAt`, and the 72-hour clip-wait timeout is unimplementable. The composition root
also imports its production clock from the *fakes* package, which is backwards.

Add a `SystemClock` and a `clock?: Clock` option on `RunPipelineOptions`. Do this first — it
is small, and every later timing feature depends on it.

### 2. Decide the render-eviction contract

**This is a gap in the spec, not just the code.** Nothing can evict the image model before the
render stage. `STAGE_REQUIREMENTS` marks `editor` as `'none'`, which does not even queue on the
broker; `evictAll()` runs only at end-of-run; and stages deliberately cannot reach the broker.
So in Plan 3, SDXL (~8 GB) would stay resident through narration, captioning and a headless
Chromium render (~3 GB) — exactly the co-residency this architecture exists to prevent. The
broker's own docstring says "call before rendering", but no caller can.

Options: introduce an eviction-forcing requirement kind (e.g. `'exclusive'`), or have
`StageRunner` evict before render-kind stages. **Decide the shape during Plan 2** so
`Stage.requires` does not have to change twice.

### 3. Validate `deps.stages` ordering and completeness

`StageRunner`'s resume logic assumes the caller passes stages in `STAGE_NAMES` order. A
reordered or partial array silently changes which stages resume. Harmless while only
`buildNoopStages()` exists; dangerous the moment Plan 2 starts passing custom stage arrays.

### 4. Add retry backoff for network stages

Retries currently have zero delay — `RetryConfig` has no delay field. Spec §8 explicitly
promises backoff for network stages. Instant triple-retry against Ollama or a rate-limited
Wikipedia endpoint just burns the attempt budget. Needed before real adapters land.

---

## Also queued for Plan 2

- **`Research` and `FactCheck` schemas have no test coverage.** They become load-bearing the
  moment real stages produce them.
- **The fake caption provider returns `[]`** for an audio path it did not itself speak, rather
  than throwing — a wiring bug in a real captioner test would surface as an empty-but-valid
  result instead of a loud failure. Make it throw once real caption tests exist.
- **No lease timeout on `evictAll()`.** A real Ollama unload can hang; a caller that leaks a
  lease blocks eviction indefinitely with no timeout.
- **`loadConfig`'s catch is too broad** — a JSON syntax error in an existing niche file is
  reported as "niche not found", which will mislead the first time a niche file is hand-edited.
- **`let lease` in `StageRunner` is an implicitly-any evolving let.** Trivial; tidy on next touch.

## Queued for Plan 4 (or before unattended operation)

- **Re-running a published run id silently demotes it** from `published` back to
  `awaiting_review` (the video id is retained and the publisher is skipped). Demonstrated by
  the reviewer. Unreachable until the publish flow exists, but the guard belongs in the engine.
- **No reaper for stranded jobs.** When `complete()` fails, the job is left `running` forever —
  the correct trade against re-running finished work, but nothing reclaims it, so it is
  invisible to the queue. Needs a reaper or a `claimedAt`-based timeout before the pipeline
  runs unattended.
- **`EventRunLogger` swallows sink errors silently** with no counter or fallback. Intentional —
  a dead log consumer must never abort a run — but a persistently failing sink is invisible.
  The Plan 4 dashboard is the first real consumer.
- **Resuming a run resolves config from the *current* request**, ignoring the stored run's
  niche and format, so a resume with a different request silently mixes configs mid-run.
- **Artifact writes are not atomic** (no temp-file-plus-rename). Self-healing today because an
  unfinished stage rewrites, but worth atomicity when artifacts get larger in Plan 3.

## Judged fine to leave

The repo-local `.npmrc` and `pnpm` `allowBuilds` entries; untested static literal constants;
the SEO tag budget counting comma separators (over-strict is the safe direction);
`JobRepository`'s find-then-update claim and non-transactional `fail()` (correct while
concurrency is pinned at 1 — re-open only if that changes); the doctor collapsing `ENOTDIR`
and `EACCES` into the same message; and the residual pre-try database throw in `StageRunner`,
which the job worker and CLI error handling both contain.

---

## Why the `Stage` contract is ready

`RunContext` already carries everything the six language-model stages need: the LLM provider
with `unload` structurally removed from stage reach, the trend provider, the artifact store,
the topic dedupe store, the clip request store, an injected clock, the logger, and the fully
resolved config. The `providers` and `stages` injection points on `runPipeline` work — the
final review's swap-count probe used exactly that path with no friction. Replacing a
placeholder stage is a drop-in.
