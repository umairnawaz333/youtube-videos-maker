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
