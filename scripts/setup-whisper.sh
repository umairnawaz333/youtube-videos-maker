#!/usr/bin/env bash
# Downloads a whisper.cpp GGML model ENTIRELY INSIDE THIS REPO, into models/whisper/, so that
# deleting the repo fully reverts the machine. Idempotent: safe to re-run — an already-present
# model file is never re-downloaded. Does not install whisper-cli itself: per the design spec
# it is already installed system-wide (`/opt/homebrew/bin/whisper-cli`, via `brew install
# whisper-cpp`), the one exception (with ffmpeg) to "everything stays in the project folder".
#
# NOTE: this script is intentionally NOT run as part of setting up this branch. Run it
# yourself when ready:  bash scripts/setup-whisper.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
mkdir -p models/whisper

# base.en (~148 MB) is the default: fast enough to transcribe dozens of short per-scene WAV
# files per run without becoming the bottleneck, and English-only matches the MVP's
# English-only scope (spec §5), which also skips the auto language-detection pass a
# multilingual model would otherwise spend time on. Override with WHISPER_MODEL for a larger
# model if word-timestamp accuracy needs to improve (e.g. small.en, ~488 MB).
MODEL="${WHISPER_MODEL:-base.en}"
MODEL_FILE="ggml-${MODEL}.bin"
RELEASE_BASE="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

dest="models/whisper/$MODEL_FILE"
if [ -s "$dest" ]; then
  echo "--> $dest already present"
else
  echo "--> downloading $MODEL_FILE into models/whisper/ (this is the slow part)"
  curl -fL --retry 3 -o "$dest" "$RELEASE_BASE/$MODEL_FILE"
fi

echo "--> weights on disk: $(du -sh models/whisper | cut -f1)"

if command -v whisper-cli >/dev/null 2>&1; then
  echo "--> whisper-cli: $(whisper-cli --version 2>&1 | head -1 || echo present)"
else
  echo "--> WARNING: whisper-cli not found on PATH. Install it with: brew install whisper-cpp" >&2
fi

echo "done."
echo "Model: $dest"
echo "Point WhisperCliCaptionProviderOptions.modelPath at $REPO_ROOT/$dest in real use."
