import { describe, expect, it, vi } from 'vitest'
import { OllamaLlmProvider, type OllamaClient, type OllamaGenerateRequest } from '@yt/providers'

const clientReturning = (...responses: string[]): OllamaClient & { calls: OllamaGenerateRequest[] } => {
  const calls: OllamaGenerateRequest[] = []
  let i = 0
  return {
    calls,
    async generate(req) {
      calls.push(req)
      return responses[Math.min(i++, responses.length - 1)]!
    },
    async unload() {},
  }
}

describe('OllamaLlmProvider.complete', () => {
  it('returns the model text and does not request JSON mode', async () => {
    const client = clientReturning('a plain answer')
    const provider = new OllamaLlmProvider({ client, model: 'test-model' })

    await expect(provider.complete('hello')).resolves.toBe('a plain answer')
    expect(client.calls[0]).toMatchObject({ model: 'test-model', prompt: 'hello', json: false })
  })

  it('passes temperature and maxTokens through', async () => {
    const client = clientReturning('x')
    const provider = new OllamaLlmProvider({ client, model: 'test-model' })

    await provider.complete('hello', { temperature: 0.2, maxTokens: 64 })

    expect(client.calls[0]).toMatchObject({ temperature: 0.2, maxTokens: 64 })
  })
})

describe('OllamaLlmProvider.json', () => {
  const parseThing = (raw: unknown) => {
    const v = raw as { ok?: boolean }
    if (typeof v?.ok !== 'boolean') throw new Error('missing ok')
    return { ok: v.ok }
  }

  it('parses a clean JSON response and asks for JSON mode', async () => {
    const client = clientReturning('{"ok":true}')
    const provider = new OllamaLlmProvider({ client, model: 'm' })

    await expect(provider.json('p', 'Thing', parseThing)).resolves.toEqual({ ok: true })
    expect(client.calls[0]!.json).toBe(true)
  })

  it('recovers JSON wrapped in a fenced code block', async () => {
    const client = clientReturning('Sure!\n```json\n{"ok":false}\n```\nHope that helps.')
    const provider = new OllamaLlmProvider({ client, model: 'm' })

    await expect(provider.json('p', 'Thing', parseThing)).resolves.toEqual({ ok: false })
  })

  it('recovers JSON surrounded by prose with no fence', async () => {
    const client = clientReturning('Here is the result: {"ok":true} — done.')
    const provider = new OllamaLlmProvider({ client, model: 'm' })

    await expect(provider.json('p', 'Thing', parseThing)).resolves.toEqual({ ok: true })
  })

  it('recovers JSON after a reasoning trace followed by a fenced block (qwen3-style)', async () => {
    const client = clientReturning(
      'Thinking...\n' +
        'The user wants JSON with an "ok" boolean. Let me work through this carefully.\n' +
        '...done thinking.\n\n' +
        '```json\n{"ok":true}\n```',
    )
    const provider = new OllamaLlmProvider({ client, model: 'm' })

    await expect(provider.json('p', 'Thing', parseThing)).resolves.toEqual({ ok: true })
  })

  it('retries when the response does not parse, then succeeds', async () => {
    const client = clientReturning('not json at all', '{"ok":true}')
    const provider = new OllamaLlmProvider({ client, model: 'm' })

    await expect(provider.json('p', 'Thing', parseThing)).resolves.toEqual({ ok: true })
    expect(client.calls).toHaveLength(2)
  })

  it('retries when the caller-supplied parse rejects the shape', async () => {
    const client = clientReturning('{"wrong":1}', '{"ok":true}')
    const provider = new OllamaLlmProvider({ client, model: 'm' })

    await expect(provider.json('p', 'Thing', parseThing)).resolves.toEqual({ ok: true })
    expect(client.calls).toHaveLength(2)
  })

  it('gives up after the configured attempts and names the schema and the raw response', async () => {
    const client = clientReturning('still not json')
    const provider = new OllamaLlmProvider({ client, model: 'm', jsonAttempts: 2 })

    await expect(provider.json('p', 'Thing', parseThing)).rejects.toThrow(/Thing/)
    await expect(provider.json('p', 'Thing', parseThing)).rejects.toThrow(/still not json/)
    expect(client.calls).toHaveLength(4) // 2 attempts per call, 2 calls
  })

  it('logs each failed attempt so a bad prompt is diagnosable', async () => {
    const log = vi.fn<(message: string) => void>()
    const client = clientReturning('nope', '{"ok":true}')
    const provider = new OllamaLlmProvider({ client, model: 'm', log })

    await provider.json('p', 'Thing', parseThing)

    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]![0]).toMatch(/Thing/)
  })
})

describe('OllamaLlmProvider.unload', () => {
  it('delegates to the client for the configured model', async () => {
    const unload = vi.fn<(model: string) => Promise<void>>(async () => {})
    const provider = new OllamaLlmProvider({
      client: { generate: async () => '', unload },
      model: 'test-model',
    })

    await provider.unload()

    expect(unload).toHaveBeenCalledWith('test-model')
  })
})
