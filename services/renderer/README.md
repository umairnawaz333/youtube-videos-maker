# @yt/renderer

The Remotion project for the render block (spec section 12, the Editor stage). Renders
`out/video.mp4` and the five composited thumbnail stills as a pure function of a
`videoSpec.json` file — no AI model is reachable from anywhere in this directory.

## Status

Source only. **Not installed, not built, never run** by the agent that wrote it — the task
explicitly forbade triggering a headless-Chromium download or a real render on this machine.
The owner is expected to test it live.

## Effects implemented

- Ken Burns (`zoom-in`, `zoom-out`) and pan (`pan-left`, `pan-right`, `parallax`) camera moves
  — `src/compositions/CameraMove.tsx`
- Blur + fade transition at every scene cut — `src/compositions/Transition.tsx`
- Word-by-word animated captions, driven by measured word timings — `src/compositions/Captions.tsx`
- Bottom progress bar — `src/compositions/ProgressBar.tsx`
- Consistent branded corner on every scene (covers the Veo watermark uniformly, spec section 11)
  — `src/compositions/BrandCorner.tsx`
- Motion graphic placeholder for the four non-model variants (timeline/map/stat/quote/list)
  — inside `src/compositions/Scene.tsx`
- Thumbnail text-overlay-as-a-still compositor — `src/compositions/ThumbnailStill.tsx`

## To make this buildable

1. Add `services/*` to the root `pnpm-workspace.yaml` package list (currently only
   `apps/*`/`packages/*`) — a shared root file the render-block agent deliberately did not
   touch. See the render-block report.
2. `cd services/renderer && pnpm install` (or from the repo root once workspace-registered).
   This is the step that may pull down Remotion's headless Chromium; run it only when you are
   ready for that.
3. `pnpm typecheck` here to confirm the TSX compiles against the real `remotion` types (the
   root `tsc -p tsconfig.base.json` does not check this directory — it isn't in that config's
   `include` glob, by design, so a missing install here never breaks `pnpm test`).
4. Optionally replace `src/types.ts` with `import type { ... } from '@yt/core'` once this
   package can depend on it as a workspace member — the two are currently kept in sync by
   hand; see the comment at the top of `src/types.ts`.

## Entry points

- `src/render.ts` — `tsx src/render.ts --spec <videoSpec.json> --out <video.mp4>`. Invoked by
  `packages/pipeline/src/render/renderer.ts`'s `createChildProcessRenderer`.
- `src/render-thumbnails.ts` — `tsx src/render-thumbnails.ts --jobs <jobs.json>`.
- `pnpm preview` — opens Remotion Studio against the placeholder spec in `src/Root.tsx`, for
  eyeballing the compositions interactively without a real pipeline run.
