# AI YouTube Factory — Phase 1 MVP Design

**Date:** 2026-08-01
**Status:** Approved
**Source blueprint:** `inital plan of youtube maker.md`

---

## 1. Purpose and scope

Build a local-first, zero-cost application that turns one command into a ready-to-publish
original YouTube video, then uploads it to the owner's channel after a human review click.

The blueprint describes a five-phase program spanning multiple channels, languages,
analytics, and AI self-improvement. That is too large for one specification. This document
covers **Phase 1 (MVP) only**. Later phases each get their own spec → plan → build cycle.
The architecture defined here is designed so those phases are additive: none of them
requires reopening these decisions.

### In scope

- Both video formats from day one, driven by config: vertical Shorts and horizontal long-form.
- Eight niche configurations (general-interest channel), selected per run.
- Full pipeline: topic discovery → research → script → fact check → scene plan → SEO →
  images → thumbnail → narration → captions → render → quality gate → publish.
- Local dashboard for triggering runs, watching progress, reviewing output, and publishing.
- Review gate: the pipeline stops at a finished video; a human clicks Publish.
  Auto-publish exists behind a config flag, off by default.

### Out of scope (deliberately deferred)

Multi-channel · analytics ingestion · scheduling and cron · languages other than English ·
A/B testing of titles and thumbnails · email reports · podcast and fully-animated formats ·
public-domain stock footage integration.

### Definition of done

Running `pnpm generate` (or clicking Generate in the dashboard) produces, in `storage/`:
an original grounded script, Kokoro narration, SDXL visuals with camera motion, animated
word-level captions, five thumbnail candidates, twenty scored titles with a winner, and a
rendered H.264 MP4 in the requested format — previewable in the dashboard, publishable in
one click.

---

## 2. Environment and constraints

Measured on the target machine:

| Component | State |
|---|---|
| Apple M5, 16 GB unified memory, 113 GB free disk | Target hardware |
| Node 26.3, npm 11.16, pnpm 11.18 | Installed |
| Python 3.14.6 | Installed |
| ffmpeg 8.1.2 | Installed |
| whisper-cli (whisper.cpp) | Installed at `/opt/homebrew/bin/whisper-cli` |
| Ollama | To install — binary into `bin/` |
| Stable Diffusion | To install — weights into `models/hf/` |
| Kokoro TTS | To install — weights into `models/tts/` |

### Everything stays in the project folder

All downloads are redirected into the repository so that deleting the folder fully reverts
the machine:

| Artifact | Mechanism | Destination |
|---|---|---|
| Ollama binary | macOS arm64 tarball, extracted locally | `bin/ollama` |
| LLM weights | `OLLAMA_MODELS` env var | `models/ollama/` |
| SDXL weights | `HF_HOME` env var | `models/hf/` |
| Kokoro voice | direct file download | `models/tts/` |
| Whisper GGML model | direct file download | `models/whisper/` |
| Python dependencies | virtualenv | `.venv/` |

Only pre-existing system tools are used from outside the folder: `ffmpeg`, `whisper-cli`,
`node`, `python3`.

### The memory constraint drives the architecture

An 8B LLM at 4-bit occupies roughly 6 GB; SDXL in fp16 roughly 8 GB; Remotion's headless
Chromium roughly 3 GB. On 16 GB of unified memory these cannot be co-resident. A pipeline
that interleaves LLM and image calls would evict and reload multi-gigabyte weights a dozen
times per run, turning a 20-minute render into hours.

Two mechanisms address this:

1. **ModelBroker** — a mutex through which every heavy model is acquired. Each stage
   declares `requires: 'llm' | 'sd' | 'none'`. Before granting a lock the broker evicts the
   other resident model: Ollama via a request with `keep_alive: 0`, the image sidecar via an
   `/unload` endpoint that releases its MPS cache.
2. **Requirement-grouped stage order** — stages are ordered so all LLM work completes before
   any image work begins, reducing model swaps per run from roughly twelve to two.

```
── LLM resident ──────────────────  ── SD resident ──   ── small models only ──────────
topic → research → script →         images →            narration → captions →
factcheck → scenes → SEO            thumbnail           render → quality gate → publish
```

This ordering is why the SD prompts are written during the ScenePlanner stage rather than
at image-generation time: the image stage must have no LLM dependency.

---

## 3. Architecture

### Stack

A pnpm monorepo with a long-lived NestJS orchestrator, a Next.js dashboard, a Remotion
renderer package, and a Python image-generation sidecar.

NestJS is chosen for two concrete reasons. A pipeline run lasts 10–60 minutes, which
requires a long-lived process — orchestration inside Next.js route handlers is the wrong
shape. And its dependency injection maps directly onto the blueprint's replaceability rule:
each provider is an interface bound to a DI token, so substituting Ollama with a hosted
model is a one-line module change.

Alternatives considered and rejected: a single Next.js app with a worker script (fewer parts,
but long-job orchestration, progress streaming, and provider wiring all get hand-rolled); and
a CLI-first core with the dashboard deferred (faster to first video, but the success criteria
are explicitly dashboard-shaped, so the trigger and progress layers would be written twice).

### Repository layout

```
youtube-videos-maker/
├─ apps/
│  ├─ api/                  NestJS: orchestrator, REST, SSE progress stream
│  └─ web/                  Next.js dashboard
├─ packages/
│  ├─ core/                 domain types, Zod schemas, provider interfaces
│  ├─ pipeline/             the thirteen stage modules
│  ├─ providers/            adapters: ollama, kokoro, sd-sidecar, whisper, youtube
│  ├─ renderer/             Remotion compositions and scene components
│  └─ db/                   Prisma schema and client (SQLite)
├─ services/
│  └─ imagegen/             Python FastAPI sidecar holding SDXL warm
├─ config/
│  ├─ app.json              global configuration
│  └─ niches/*.json         eight niche configurations
├─ models/                  all model weights (gitignored)
├─ bin/                     locally downloaded binaries (gitignored)
├─ storage/                 per-run assets (gitignored)
├─ assets/music/            optional CC0 music with a license manifest
└─ docs/
```

### Storage layout

One self-contained, hand-inspectable directory per run:

```
storage/videos/<runId>/
  research.json  script.json  factcheck.json  scenes.json  seo.json  videoSpec.json
  audio/scene-001.wav …
  images/scene-001.png …
  captions/words.json  captions.srt
  thumbnail/v1.png … v5.png
  out/video.mp4
```

### Job queue

A SQLite `jobs` table with an in-process worker at concurrency 1 — the memory constraint
makes serial execution mandatory, so no Redis or BullMQ is needed and nothing extra must be
installed.

Because every stage writes its artifact to disk and records completion in the database, a run
that fails at minute 45 **resumes from its last completed stage** rather than restarting. A
single stage can also be force-rerun in isolation — for example regenerating images with an
adjusted style — without repeating research and scripting.

### Provider interfaces

Every external capability is an interface in `packages/core`, with concrete adapters in
`packages/providers`:

| Interface | MVP adapter | Later options |
|---|---|---|
| `LlmProvider` | Ollama (qwen3:8b) | Claude, OpenAI, any hosted model |
| `TtsProvider` | Kokoro-82M | Piper (implemented as fallback), hosted TTS |
| `ImageProvider` | SDXL-Turbo sidecar | FLUX via MLX, hosted image APIs |
| `CaptionProvider` | whisper.cpp | hosted transcription |
| `PublishProvider` | YouTube Data API v3 | additional platforms |
| `TrendProvider` | keyless public sources | paid trend APIs |

No stage references a concrete implementation. A stage cannot tell which model it is using.

---

## 4. Pipeline stages

Every stage implements one interface:

```ts
interface Stage {
  name: StageName
  requires: 'llm' | 'sd' | 'none'
  run(ctx: RunContext): Promise<void>   // reads artifacts, writes artifacts, idempotent
}
```

`RunContext` provides the run's configuration (niche plus format preset), its storage
directory, a logger that streams to the dashboard over SSE, and the provider interfaces.

### LLM-resident block

**1. TopicScout** → `topic`
Gathers candidates from keyless public sources selected per niche: the Wikipedia
most-viewed API (knowledge, science, history), the Hacker News Algolia API (tech), arXiv RSS
(AI), Reddit public JSON, and the Google Trends daily RSS feed. Every candidate is checked
against a `topics` table so a topic is never reused. The LLM scores survivors on curiosity,
explainability, visual potential, and evergreen value, and selects one. Together with
Publisher, this is the only stage that makes outbound network requests.

**2. Researcher** → `research.json`
Retrieves Wikipedia REST summaries and section extracts for the topic and its principal
entities, storing each fact with its source URL. This file is the sole source of truth for
the script; the writer may not introduce facts absent from it.

**3. ScriptWriter** → `script.json`
Fills the blueprint's story skeleton as an explicit `beats[]` array — hook, question,
conflict, curiosity, reveal, twist, conclusion, call to action — each beat carrying a target
duration. Total word count derives from `duration × 150 wpm`. The "introduce something new
every 15–30 seconds" rule is enforced by schema validation: a beat whose target duration
exceeds 30 seconds is rejected and regenerated.

**4. FactChecker** → `factcheck.json`
Extracts atomic claims and labels each supported, unsupported, or contradicted against
`research.json`, with a Wikipedia lookup for anything unsourced. Contradicted claims are
rewritten. If more than 15% of claims fail, the run halts. This matters more for a
general-interest channel spanning science and politics than it would for a single safe niche.

**5. ScenePlanner** → `scenes.json`
Splits the script into scenes, assigning each a visual directive and a camera move
(zoom in, zoom out, pan left, pan right, parallax):

- `sd-image` — a generated image; **its prompt is written here**, keeping the image stage
  free of any LLM dependency
- `motion-graphic: timeline | map | stat | quote | list` — pure Remotion, no model, instant
- `reuse: <sceneId>` — an earlier image under a different crop and camera move

An image budget of roughly one image per 8–10 seconds of long-form narration is enforced, so
a ten-minute video needs about seventy images rather than three hundred. Remaining time is
filled with motion graphics, which is also what prevents the output feeling like a slideshow.

**6. SEO** → `seo.json`
Generates twenty titles, scored by an LLM rubric on curiosity, search intent, simplicity, and
CTR potential; the highest scorer is preselected and all twenty are retained for the later
A/B phase. Also produces the description with timestamps, tags, and hashtags. Placed here to
remain inside the LLM block.

### SD-resident block

**7. Illustrator** → `images/*.png`
The Python sidecar holds **SDXL-Turbo** resident, producing roughly 1–2 seconds per image at
1024² in four steps. Keeping the model warm is essential; loading weights per image would cost
an order of magnitude more. Style consistency comes from a per-niche style suffix combined
with a per-run base seed. Black or failed outputs are retried automatically.

**8. Thumbnailer** → `thumbnail/v1..v5.png`
SDXL renders five hero images; Remotion composites the text overlay as a still, optimising for
high contrast, large readable type, a single clear subject, and minimal clutter. All five are
stored for later comparison.

### Small-model block

**9. Narrator** → `audio/scene-NNN.wav`
**Kokoro-82M** is the primary voice rather than Piper: at roughly 350 MB it remains fully
local and free, and its quality margin over Piper is large enough to affect watch time
directly. Piper is implemented behind the same `TtsProvider` interface as a fallback. Audio is
generated per scene so scene durations are **measured rather than estimated**, which is what
keeps the visuals locked to the narration.

**10. Captioner** → `captions/words.json`, `captions.srt`
Runs the already-installed `whisper-cli` over the narration to obtain **word-level
timestamps**, driving word-by-word animated captions in Remotion. The SRT is also uploaded to
YouTube for search indexing.

**11. Editor** → `out/video.mp4`
Remotion renders from a single `videoSpec.json` containing scenes, asset paths, exact
timings, captions, and the format preset. The renderer is therefore a pure function of that
file and can be re-run without invoking any AI model. Effects: Ken Burns, parallax,
blur and fade transitions, animated captions, progress bar. An optional music bed is read
from `assets/music/` alongside a license manifest; the directory ships empty, since no audio
whose license cannot be verified will be included.

| Preset | Resolution | Duration | Scenes | Images |
|---|---|---|---|---|
| `shorts` | 1080×1920 | 45–60 s | 8–12 | 6–10 |
| `long` | 1920×1080 | 8–10 min | 60–90 | ~70 |

Both encode H.264 at 30 fps.

**12. QualityGate**
Halts the run with a human-readable reason if any check fails: audio and video durations
disagree by more than 2%; any referenced asset is missing; sampled frames are entirely black;
the audio track is silent; the thumbnail is absent; captions are absent; the title exceeds
100 characters; the description exceeds 5000 characters; or the tags exceed 500 characters in
total.

**13. Publisher**
Performs a resumable YouTube Data API v3 upload, setting metadata, thumbnail, and caption
track, applying the configured privacy status, and recording the returned video ID. Runs only
after the human review click, unless auto-publish is explicitly enabled.

Two upload constraints apply while the OAuth application is new. In **Testing** mode, YouTube
forces every upload to private regardless of the requested privacy status, so "Publish" means
"uploaded — now flip to public in YouTube Studio" until the app is submitted for verification.
And an unaudited project's quota of 10,000 units per day against 1,600 units per upload caps
throughput at roughly six uploads per day: irrelevant for one video daily, but relevant to the
multi-channel phase.

---

## 5. Configuration

No values are hardcoded. `config/app.json` holds global settings; each niche is a file in
`config/niches/`.

```json
{
  "niche": "space",
  "language": "English",
  "videoType": "long",
  "duration": 8,
  "voice": "male",
  "resolution": "1920x1080",
  "upload": true,
  "captions": true,
  "thumbnail": true,
  "autoPublish": false
}
```

A niche configuration carries its prompt guidance, voice selection, visual style suffix, music
preference, trend sources, SEO rules, and a `monetizationRisk` field.

Eight niches ship in the MVP: tech, AI, programming, space, science, education, knowledge, and
politics.

Two consequences of the general-interest channel decision are handled in configuration rather
than argued away. First, **politics carries monetization risk**: YouTube's advertiser-friendly
guidelines penalise partisan or controversial framing, so that niche's configuration is
explainer-only — how systems work, historical policy — with a safe-framing instruction in its
prompt and a `monetizationRisk` field allowing it to be disabled. Second, a general channel
dilutes the algorithm's audience signal; every video row is therefore tagged with its niche so
the later analytics phase can identify which niches actually performed, allowing the channel to
narrow on evidence rather than guesswork.

---

## 6. Data model (Prisma / SQLite)

| Model | Purpose |
|---|---|
| `Run` | one pipeline execution: niche, format, status, current stage, timings, video ID |
| `StageRun` | per-stage status, attempts, duration, error message |
| `Topic` | every topic ever used, for permanent deduplication |
| `Asset` | files produced by a run, with type and path |
| `TitleCandidate` | all twenty titles with rubric scores and which was chosen |
| `Job` | queue rows: type, payload, attempts, state |

---

## 7. Testing strategy

Because every provider sits behind an interface, the test suite ships **fakes**: an LLM
returning canned schema-valid JSON, a TTS emitting a one-second sine WAV, an image provider
emitting a solid-colour PNG, and a publisher that records its calls. The consequence is that
**the entire thirteen-stage pipeline runs end-to-end in seconds with no models loaded**, which
is what makes it practical to test-drive stage logic — scene budgeting, beat-duration
enforcement, fact-check thresholds, quality-gate rules — instead of waiting forty minutes to
discover an off-by-one scene index.

Real models are exercised by a separate opt-in integration suite (`pnpm test:integration`).
A `doctor` command verifies that binaries, weights, and free disk space are present, and is
surfaced as a dashboard page.

Development follows test-driven development: write the failing test, confirm it fails, then
implement.

---

## 8. Error handling

Retry counts come from configuration: three attempts for LLM stages, three with backoff for
network stages, one for rendering. Every failure records its stage, message, and timestamp in
the database and appears in the dashboard — there are no silent failures and no partially
published videos. Because artifacts are written stage by stage, a failed run resumes from the
last good stage, and any single stage can be force-rerun.

The `RunContext` logger streams over SSE so the dashboard shows live progress rather than an
opaque spinner for forty minutes.

---

## 9. Dashboard

- **Runs** — list showing niche, format, status, duration, and thumbnail
- **Run detail** — live stage timeline and logs, video player, five thumbnail candidates to
  choose from, all twenty scored titles with the winner preselected, editable description and
  tags, and a Publish button
- **Config** — form-based editing of `app.json` and the eight niche files
- **Doctor** — pass/fail checks for every dependency and model

---

## 10. Original content guarantee

The application never downloads and re-uploads another creator's video. Every asset is either
generated locally (script, narration, images, motion graphics, thumbnails) or, in later phases,
drawn from public-domain and compatibly licensed sources with recorded attribution. The MVP
generates 100% of its visual and audio content locally, so no attribution bookkeeping is
required in Phase 1.

---

## 11. Verification checklist for Phase 1 completion

1. `pnpm doctor` reports every dependency and model present.
2. The unit suite passes with fakes, in seconds, with no models loaded.
3. A `shorts` run completes in under 10 minutes and produces a playable 1080×1920 MP4.
4. A `long` run completes in under 60 minutes and produces a playable 1920×1080 MP4.
5. Captions are word-level aligned to the narration.
6. The quality gate demonstrably blocks a deliberately broken run and names the reason.
7. A killed run resumes from its last completed stage rather than restarting.
8. Clicking Publish uploads to the target channel and records the video ID.
