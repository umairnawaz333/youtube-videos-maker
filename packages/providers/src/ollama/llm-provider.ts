import type { LlmProvider } from '@yt/core'
import type { OllamaClient } from './client'

/**
 * Local models frequently wrap JSON in prose or a fenced block even when told not to, so
 * pull the outermost JSON value out of whatever came back before parsing.
 */
export const extractJson = (raw: string): string => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const text = (fenced?.[1] ?? raw).trim()

  const firstObj = text.indexOf('{')
  const firstArr = text.indexOf('[')
  const start =
    firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr)
  if (start === -1) return text

  const closer = text[start] === '{' ? '}' : ']'
  const end = text.lastIndexOf(closer)
  return end > start ? text.slice(start, end + 1) : text.slice(start)
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
  async json<T>(prompt: string, schemaName: string, parse: (raw: unknown) => T): Promise<T> {
    let lastRaw = ''
    let lastError = 'unknown error'

    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      lastRaw = await this.deps.client.generate({
        model: this.deps.model,
        prompt,
        json: true,
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
