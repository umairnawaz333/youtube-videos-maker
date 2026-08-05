#!/usr/bin/env bash
# Sets up the local image-generation environment: a Python virtualenv for the SDXL sidecar
# and the SDXL-Turbo weights. Everything lands inside the repo, so deleting the checkout
# reverts the machine — the same rule scripts/setup-ollama.sh follows for the LLM.
#
# Idempotent: an existing venv is reused and already-downloaded weights are not re-fetched.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO_ROOT"

VENV="$REPO_ROOT/.venv"
# Resolve through the `models` symlink a worktree may use, so the 7 GB of weights is shared
# with the main checkout rather than downloaded per worktree.
MODELS_DIR="$(cd models && pwd -P)"
export HF_HOME="$MODELS_DIR/hf"
IMAGE_MODEL="${IMAGE_MODEL:-stabilityai/sdxl-turbo}"

# Python 3.14 is too new for the diffusers/transformers wheel matrix at time of writing, so
# prefer a known-good interpreter and only fall back to `python3` if nothing better exists.
pick_python() {
  for candidate in python3.12 python3.11 python3.13 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      echo "$candidate"
      return 0
    fi
  done
  echo "no python3 found on PATH" >&2
  exit 1
}

PYTHON="$(pick_python)"
echo "--> using $PYTHON ($("$PYTHON" --version 2>&1))"

if [ -x "$VENV/bin/python" ]; then
  echo "--> virtualenv already present at .venv"
else
  echo "--> creating virtualenv at .venv"
  "$PYTHON" -m venv "$VENV"
fi

echo "--> installing sidecar dependencies"
"$VENV/bin/python" -m pip install --quiet --upgrade pip
"$VENV/bin/python" -m pip install --quiet -r "$REPO_ROOT/services/imagegen/requirements.txt"

# `hf download` resumes and verifies, so re-running costs a metadata check rather than 7 GB.
echo "--> fetching $IMAGE_MODEL weights into ${HF_HOME/#$REPO_ROOT\//}"
"$VENV/bin/hf" download "$IMAGE_MODEL" \
  --exclude "*.onnx" "*.onnx_data" "sd_xl_turbo_1.0.safetensors" "sd_xl_turbo_1.0_fp16.safetensors"

echo
echo "READY — run the sidecar with: pnpm imagegen:serve"
