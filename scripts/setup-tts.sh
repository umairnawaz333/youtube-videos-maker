#!/usr/bin/env bash
# Installs the Kokoro-82M TTS voice ENTIRELY INSIDE THIS REPO: the ONNX model and voice pack
# into models/tts/, and the `kokoro-onnx` / `soundfile` python packages into .venv/, so that
# deleting the repo fully reverts the machine. Idempotent: safe to re-run — an already-present
# weight file or already-installed package is never re-downloaded or reinstalled.
#
# NOTE: this script is intentionally NOT run as part of setting up this branch. Run it
# yourself when ready:  bash scripts/setup-tts.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
mkdir -p models/tts

# Full f32 weights (~310 MB) + the voice pack (~27 MB) land at roughly the "~350 MB" figure the
# design spec cites for Kokoro. Set KOKORO_VARIANT=fp16 (~169 MB) or KOKORO_VARIANT=int8
# (~88 MB) for a smaller download on a lower-memory machine; quality drops a little at each
# smaller size. Voices are shared across all three variants.
VARIANT="${KOKORO_VARIANT:-fp32}"
case "$VARIANT" in
  fp32) MODEL_FILE="kokoro-v1.0.onnx" ;;
  fp16) MODEL_FILE="kokoro-v1.0.fp16.onnx" ;;
  int8) MODEL_FILE="kokoro-v1.0.int8.onnx" ;;
  *)
    echo "unknown KOKORO_VARIANT '$VARIANT' (expected fp32, fp16, or int8)" >&2
    exit 1
    ;;
esac
VOICES_FILE="voices-v1.0.bin"
RELEASE_BASE="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"

download() {
  local file="$1"
  local dest="models/tts/$file"
  if [ -s "$dest" ]; then
    echo "--> $dest already present"
    return
  fi
  echo "--> downloading $file into models/tts/ (this is the slow part)"
  curl -fL --retry 3 -o "$dest" "$RELEASE_BASE/$file"
}

download "$MODEL_FILE"
download "$VOICES_FILE"

echo "--> setting up the python virtualenv (.venv/)"
if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
python -m pip install --quiet --upgrade pip
if python -m pip show kokoro-onnx >/dev/null 2>&1; then
  echo "--> kokoro-onnx already installed in .venv"
else
  echo "--> installing kokoro-onnx and soundfile into .venv"
  python -m pip install --quiet kokoro-onnx soundfile
fi
deactivate

echo "--> weights on disk: $(du -sh models/tts | cut -f1)"
echo "--> smoke test (import only — does not load the model)"
.venv/bin/python3 -c "import kokoro_onnx, soundfile; print('kokoro-onnx import OK')"

echo "done."
echo "Model:  models/tts/$MODEL_FILE"
echo "Voices: models/tts/$VOICES_FILE"
echo "Point KokoroTtsProviderOptions.pythonBin at $REPO_ROOT/.venv/bin/python3 in real use."
