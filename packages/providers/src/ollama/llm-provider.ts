import type { LlmProvider } from '@yt/core'
import type { OllamaClient } from './client'

/**
 * Starting at `start` (which must be `{` or `[`), scan forward tracking string-literal state
 * (respecting `\"` escapes) and bracket depth. Returns the balanced span if `start`'s bracket
 * closes before the text ends, or null if it never does (a stray/unmatched opening bracket).
 */
const matchBalancedSpan = (text: string, start: number): string | null => {
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]

    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }

    if (ch === '{' || ch === '[') {
      depth++
    } else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }

  return null
}

/**
 * Find every balanced `{...}` / `[...]` span in `text`, grouped by top-level "family": a
 * family is one outermost bracket plus every span nested inside it (outer span first, then its
 * descendants in the order their opening bracket appears). A `{` or `[` that never closes (a
 * stray brace in surrounding prose) contributes no span rather than corrupting the depth count
 * for brackets that follow it.
 *
 * Families are returned LAST-FIRST so a later sibling JSON value (a second, separate top-level
 * object/array following the first) is preferred over an earlier one — the same "prefer the
 * later occurrence" rule `extractJson` already applies across fenced blocks. Nesting is
 * structural, not a sequence of drafts, so a span's own descendants stay in outer-first order
 * within its family rather than being caught up in that reversal.
 */
const balancedSpans = (text: string): string[] => {
  const families: string[][] = []
  let currentFamily: string[] | null = null
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }

    if (ch === '{' || ch === '[') {
      if (depth === 0) {
        currentFamily = []
        families.push(currentFamily)
      }
      depth++
      const span = matchBalancedSpan(text, i)
      if (span) currentFamily?.push(span)
    } else if (ch === '}' || ch === ']') {
      depth = Math.max(0, depth - 1)
    }
  }

  return families.reverse().flat()
}

/**
 * Local models frequently wrap JSON in prose or a fenced block even when told not to, so pull
 * the outermost JSON value out of whatever came back before parsing.
 *
 * Candidates are tried in order and the first one that actually parses is returned — the
 * caller's schema check is the final arbiter, so a parseable-but-wrong-shaped span is fine
 * where an unparseable one is not. "Prefer the later occurrence" is applied uniformly: fenced
 * blocks are checked last-to-first (a model's real answer tends to follow any draft/example
 * block), and `balancedSpans` applies that same rule one level down — among the top-level JSON
 * values found within a single candidate string (a fenced block's contents, or the whole
 * unfenced response), the later one is tried first. Otherwise a model that echoes the prompt's
 * own JSON template (or writes an example object) before its real answer would have that draft
 * picked first, exactly the bug the fenced-block ordering already guards against one level up.
 */
export const extractJson = (raw: string): string => {
  const trimmed = raw.trim()

  const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => (m[1] ?? '').trim())

  const candidates: string[] = []
  for (const block of [...fenced].reverse()) {
    candidates.push(...balancedSpans(block))
  }
  candidates.push(...balancedSpans(raw))

  for (const candidate of candidates) {
    try {
      JSON.parse(candidate)
      return candidate
    } catch {
      // not this one — try the next candidate
    }
  }

  // Nothing parsed: fall back to the first candidate (if any) so the caller gets a useful
  // syntax error, or the outermost fenced block, or the raw trimmed text.
  return candidates[0] ?? fenced[0] ?? trimmed
}

export class OllamaLlmProvider implements LlmProvider {
  private readonly attempts: number

  constructor(
    private readonly deps: {
      client: OllamaClient
      model: string
      /** How many times to re-ask when the response will not parse. */
      jsonAttempts?: number
      log?: (message: string) => void
    },
  ) {
    this.attempts = deps.jsonAttempts ?? 3
  }

  async complete(prompt: string, opts?: { temperature?: number; maxTokens?: number }): Promise<string> {
    return this.deps.client.generate({
      model: this.deps.model,
      prompt,
      json: false,
      ...(opts?.temperature === undefined ? {} : { temperature: opts.temperature }),
      ...(opts?.maxTokens === undefined ? {} : { maxTokens: opts.maxTokens }),
    })
  }

  /**
   * The interface's contract is that stages never see malformed JSON, so the retry loop
   * lives here rather than in every stage. A caller-supplied `parse` that throws counts as
   * a failed attempt: a syntactically valid but wrongly-shaped response is just as unusable.
   */
  async json<T>(
    prompt: string,
    schemaName: string,
    parse: (raw: unknown) => T,
    opts?: { temperature?: number; maxTokens?: number },
  ): Promise<T> {
    let lastRaw = ''
    let lastError = 'unknown error'

    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      lastRaw = await this.deps.client.generate({
        model: this.deps.model,
        prompt,
        json: true,
        ...(opts?.temperature === undefined ? {} : { temperature: opts.temperature }),
        ...(opts?.maxTokens === undefined ? {} : { maxTokens: opts.maxTokens }),
      })

      try {
        return parse(JSON.parse(extractJson(lastRaw)))
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        this.deps.log?.(
          `${schemaName}: attempt ${attempt}/${this.attempts} produced unusable output (${lastError})`,
        )
      }
    }

    const excerpt = lastRaw.length > 500 ? `${lastRaw.slice(0, 500)}…` : lastRaw
    throw new Error(
      `model did not produce valid ${schemaName} after ${this.attempts} attempts ` +
        `(last error: ${lastError}). Last response was: ${excerpt}`,
    )
  }

  /** Called by the ModelBroker only. */
  async unload(): Promise<void> {
    await this.deps.client.unload(this.deps.model)
  }
}
