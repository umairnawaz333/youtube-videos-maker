"""FastAPI sidecar holding SDXL-Turbo resident in memory.

See docs/superpowers/specs/2026-08-01-ai-youtube-factory-mvp-design.md, section 2 (the memory
constraint) and section 4, stage 7: an 8B LLM and SDXL cannot be co-resident in 16 GB of unified
memory, so the Node-side ModelBroker holds at most one of them loaded at a time and evicts the
other before granting a lock. For the image side that eviction is this service's /unload
endpoint, which releases the pipeline and clears the MPS cache.

Endpoints:
  GET  /health    -> {"status": "ok", "loaded": bool, "device": str, "model": str}
  POST /generate  -> PNG bytes for the requested prompt/size/seed/steps
  POST /unload    -> releases the pipeline and clears the MPS cache

Not started, imported for model loading, or exercised by the Node test suite: that suite is
hermetic and talks to an injected fake `ImageProvider` / `fetchImpl` instead (see
packages/providers/src/image and packages/pipeline/src/stages/illustrator.ts). This process is
run by hand via `pnpm imagegen:serve` and exercised by the opt-in integration suite described in
the spec's testing strategy (section 7).

Run with: pnpm imagegen:serve
"""

from __future__ import annotations

import io
import os
import threading

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

# Overridable so the integration suite (or a future MLX/FLUX swap) can point at a different
# checkpoint without editing this file — the same pattern scripts/setup-imagegen.sh already
# follows for the download step.
MODEL_ID = os.environ.get("IMAGE_MODEL", "stabilityai/sdxl-turbo")
DEVICE = os.environ.get("IMAGE_DEVICE", "mps")

# SDXL-Turbo is distilled for few-step, classifier-free-guidance-free sampling — the spec's
# "roughly 1-2 seconds per image at 1024^2 in four steps" depends on both of these staying low.
DEFAULT_STEPS = 4
DEFAULT_GUIDANCE_SCALE = 0.0

app = FastAPI(title="imagegen-sidecar")

# Guards `_pipeline` so two overlapping requests can never load the model twice, or unload it
# out from under an in-flight /generate call. The diffusers pipeline itself is not safe to call
# from two threads at once either.
_lock = threading.Lock()
_pipeline = None


def _load_pipeline():
    """Lazily imports torch/diffusers and loads the pipeline on first use, so the module can be
    imported (e.g. by a syntax check, or by a test that only exercises routing) without the
    heavy ML stack installed or any weights on disk. Keeping the model warm across calls after
    that first load is the entire point of this service: reloading SDXL-Turbo's weights per
    image would cost an order of magnitude more than the warm-model latency the spec targets."""
    global _pipeline
    if _pipeline is not None:
        return _pipeline

    import torch
    from diffusers import AutoPipelineForText2Image

    pipeline = AutoPipelineForText2Image.from_pretrained(
        MODEL_ID,
        torch_dtype=torch.float16,
        variant="fp16",
    )
    _pipeline = pipeline.to(DEVICE)
    return _pipeline


class GenerateRequest(BaseModel):
    prompt: str
    width: int = Field(default=1024, gt=0)
    height: int = Field(default=1024, gt=0)
    seed: int = 0
    steps: int = Field(default=DEFAULT_STEPS, gt=0)
    guidance_scale: float = DEFAULT_GUIDANCE_SCALE


@app.get("/health")
def health():
    return {
        "status": "ok",
        "loaded": _pipeline is not None,
        "device": DEVICE,
        "model": MODEL_ID,
    }


@app.post("/generate")
def generate(req: GenerateRequest) -> Response:
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt must not be empty")

    import torch

    with _lock:
        try:
            pipeline = _load_pipeline()
            generator = torch.Generator(device=DEVICE).manual_seed(req.seed)
            result = pipeline(
                prompt=req.prompt,
                width=req.width,
                height=req.height,
                num_inference_steps=req.steps,
                guidance_scale=req.guidance_scale,
                generator=generator,
            )
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001 - surfaced to the caller, not swallowed
            raise HTTPException(status_code=500, detail=f"generation failed: {exc}") from exc

    image = result.images[0]
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png")


@app.post("/unload")
def unload():
    """Releases the pipeline and clears the MPS cache. Called by the Node-side ModelBroker
    before it grants the LLM a lock — never by anything else. Idempotent: unloading when
    nothing is loaded is a no-op, not an error, since the broker's eviction path always calls
    this defensively regardless of what it believes is currently resident."""
    global _pipeline
    with _lock:
        if _pipeline is not None:
            del _pipeline
            _pipeline = None

        import torch

        if torch.backends.mps.is_available():
            torch.mps.empty_cache()

    return {"status": "unloaded"}
