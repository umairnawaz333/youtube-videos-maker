# assets/music/ — license manifest

Optional background music for the Editor's render (spec section 12). This directory **ships
empty on purpose** — no audio whose license cannot be verified is ever added here, by this
agent or otherwise. `.gitignore` enforces the same rule structurally: every file under
`assets/music/` is ignored except this manifest, `manifest.json`, and `.gitkeep`, so an audio
file cannot be committed by accident.

## Current state

**Zero tracks.** `manifest.json` lists none, and every run currently renders without a music
bed until a verified track is added here.

## How it works

`manifest.json` lists every available track and its license, one entry per track:

```json
{
  "tracks": [
    {
      "file": "drone-1.mp3",
      "mood": "ambient-drone",
      "license": "CC0",
      "sourceUrl": "https://example.org/where-you-got-it",
      "attribution": "Optional — CC0 needs none, but record it if the source asks anyway"
    }
  ]
}
```

The Editor stage (`packages/pipeline/src/render/music.ts`, `resolveMusicPath`) looks up the
current niche's `music` mood (e.g. `"ambient-drone"`, from `config/niches/*.json`) against
`manifest.json`'s `mood` field, case-insensitively, and on a match hands the renderer that
track's absolute path. No match, or no manifest at all, resolves to `null` — the render
proceeds silently rather than blocking, exactly like a missing Veo clip degrades to its
fallback image rather than stopping the run.

## Adding a track

Only add audio you can point to a specific, verifiable license for — CC0 / public domain is
the bar the spec sets ("optional CC0 music with a license manifest").

1. Drop the audio file directly in this directory (e.g. `assets/music/drone-1.mp3`).
2. Add its entry to `manifest.json`, as shown above.
3. `mood` should match a niche's `music` field in `config/niches/*.json` exactly
   (case-insensitive) for it to be picked up automatically.
4. Update this file's "current state" note.
