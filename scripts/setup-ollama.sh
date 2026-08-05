#!/usr/bin/env bash
# Installs Ollama and one language model ENTIRELY INSIDE THIS REPO, so that deleting the
# repo fully reverts the machine. Idempotent: safe to re-run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
mkdir -p bin models/ollama
# `models/` may be a symlink (e.g. into the main checkout, when this is a git worktree).
# `cd`-ing into it and taking `pwd -P` resolves through that symlink to the real, physical
# directory, so OLLAMA_MODELS stays valid even if this worktree is later removed — a plain
# "$REPO_ROOT/models/ollama" concatenation would still be a path through the now-gone worktree.
export OLLAMA_MODELS="$(cd models/ollama && pwd -P)"
# Matches the client's default requested context (packages/core/src/schemas/config.ts,
# `llm.numCtx`): Ollama's own default (4,096) is small enough that a fact-heavy prompt can
# overflow it before a single instruction token is added, which reproducibly caused a
# hallucinated `{"error": ...}` refusal in place of a real response. This only sets the
# server's default for a manually-started server; a client request that sends its own `num_ctx`
# still wins.
export OLLAMA_CONTEXT_LENGTH="${OLLAMA_CONTEXT_LENGTH:-16384}"

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
