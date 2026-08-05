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
