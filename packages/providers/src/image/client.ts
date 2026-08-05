export interface ImageGenerateRequest {
  prompt: string
  width: number
  height: number
  seed: number
  /** Diffusion steps. Left to the sidecar's own default (4, per SDXL-Turbo) when omitted. */
  steps?: number
}

export interface ImageGenClient {
  /** Returns the raw PNG bytes for the requested image. Writing them to disk is the caller's
   * job (see `HttpImageProvider`), so this client stays a pure HTTP transport. */
  generate(req: ImageGenerateRequest): Promise<Buffer>
  /** Releases the sidecar's model memory and MPS cache. Called by the ModelBroker via the
   * provider, never directly by a stage. */
  unload(): Promise<void>
}

/**
 * Talks to the local imagegen sidecar (`services/imagegen`) over HTTP. It never starts the
 * server itself: the server's lifetime is the operator's business (`pnpm imagegen:serve`), and
 * silently spawning a Python process holding several gigabytes of SDXL weights from inside the
 * Node pipeline would leave an orphaned process behind. Mirrors the conventions of
 * `packages/providers/src/ollama/client.ts`.
 */
export const createHttpImageGenClient = (opts: { host: string; fetchImpl?: typeof fetch }): ImageGenClient => {
  const doFetch = opts.fetchImpl ?? fetch
  const base = opts.host.replace(/\/+$/, '')

  const unreachable = (error: unknown): Error => {
    // A bare fetch TypeError's own `.message` is an unhelpful "fetch failed" — the useful
    // detail (ECONNREFUSED, a timed-out body, ...) lives on `.cause`. Surfacing both means a
    // slow-but-alive sidecar mid-generation reads as "slow", not as "not running".
    const cause =
      error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : ''
    const detail = error instanceof Error ? `${error.message}${cause}` : String(error)
    return new Error(
      `cannot reach the image generation sidecar at ${base} (${detail}). ` +
        "If it isn't running, start one with: pnpm imagegen:serve. If it is running, this may " +
        'be a slow generation timing out rather than a dead server.',
    )
  }

  return {
    async generate(req) {
      let res: Response
      try {
        res = await doFetch(`${base}/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt: req.prompt,
            width: req.width,
            height: req.height,
            seed: req.seed,
            ...(req.steps === undefined ? {} : { steps: req.steps }),
          }),
        })
      } catch (error) {
        throw unreachable(error)
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(
          `image generation sidecar returned ${res.status} ${res.statusText} for /generate` +
            (detail ? `: ${detail}` : ''),
        )
      }

      const arrayBuffer = await res.arrayBuffer()
      return Buffer.from(arrayBuffer)
    },

    async unload() {
      let res: Response
      try {
        res = await doFetch(`${base}/unload`, { method: 'POST' })
      } catch (error) {
        throw unreachable(error)
      }

      if (!res.ok) {
        throw new Error(`image generation sidecar returned ${res.status} ${res.statusText} for /unload`)
      }
    },
  }
}
