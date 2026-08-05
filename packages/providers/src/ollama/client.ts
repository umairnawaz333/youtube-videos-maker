export interface OllamaGenerateRequest {
  model: string
  prompt: string
  /** Ask the server to constrain output to JSON. */
  json: boolean
  temperature?: number
  maxTokens?: number
  /** Context window size in tokens, forwarded to Ollama as `num_ctx`. */
  numCtx?: number
}

export interface OllamaClient {
  generate(req: OllamaGenerateRequest): Promise<string>
  /** Releases the model's memory. Called by the ModelBroker via the provider, never by a stage. */
  unload(model: string): Promise<void>
}

interface OllamaGenerateResponse {
  response?: string
}

/**
 * Talks to a locally-running Ollama over HTTP. It never starts a server: the server's
 * lifetime is the operator's business (`pnpm ollama:serve`), and silently spawning one from
 * inside the pipeline would leave an orphaned process holding gigabytes of memory.
 */
export const createHttpOllamaClient = (opts: {
  host: string
  fetchImpl?: typeof fetch
}): OllamaClient => {
  const doFetch = opts.fetchImpl ?? fetch
  const base = opts.host.replace(/\/+$/, '')

  const post = async (path: string, body: unknown): Promise<Response> => {
    try {
      return await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (error) {
      // A bare fetch TypeError's own `.message` is an unhelpful "fetch failed" — the useful
      // detail (ECONNREFUSED, a headers/body timeout, ...) lives on `.cause`. Surfacing both
      // means a slow-but-alive server reads as "slow", not as "not running", which matters:
      // a long generation on a local model can legitimately take minutes.
      const cause =
        error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : ''
      const detail = error instanceof Error ? `${error.message}${cause}` : String(error)
      throw new Error(
        `cannot reach the model server at ${base} (${detail}). ` +
          "If it isn't running, start one with: pnpm ollama:serve. If it is running, this may " +
          'be a slow response timing out rather than a dead server.',
      )
    }
  }

  return {
    async generate(req) {
      const res = await post('/api/generate', {
        model: req.model,
        prompt: req.prompt,
        stream: false,
        ...(req.json ? { format: 'json' } : {}),
        options: {
          ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
          ...(req.maxTokens === undefined ? {} : { num_predict: req.maxTokens }),
          ...(req.numCtx === undefined ? {} : { num_ctx: req.numCtx }),
        },
      })
      if (!res.ok) {
        throw new Error(`model server returned ${res.status} ${res.statusText} for /api/generate`)
      }
      const body = (await res.json()) as OllamaGenerateResponse
      return body.response ?? ''
    },

    async unload(model) {
      // keep_alive: 0 is how Ollama is told to drop the model from memory immediately.
      const res = await post('/api/generate', { model, prompt: '', keep_alive: 0 })
      if (!res.ok) {
        throw new Error(`model server returned ${res.status} unloading '${model}'`)
      }
    },
  }
}
