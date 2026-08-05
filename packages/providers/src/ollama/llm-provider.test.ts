import { describe, expect, it, vi } from 'vitest'
import { OllamaLlmProvider, extractJson, type OllamaClient, type OllamaGenerateRequest } from '@yt/providers'

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

describe('extractJson', () => {
  it('picks the LAST fenced block when an earlier one is a format example', () => {
    const raw =
      'Format example:\n```json\n{"note":"example"}\n```\nActual answer:\n```json\n{"ok":true}\n```'

    expect(JSON.parse(extractJson(raw))).toEqual({ ok: true })
  })

  it('does not treat a brace inside a string literal as ending the span', () => {
    const raw = '{"ok":true,"note":"a brace } inside a string"}'

    expect(JSON.parse(extractJson(raw))).toEqual({ ok: true, note: 'a brace } inside a string' })
  })

  it('ignores a stray brace in prose that precedes the real payload', () => {
    const raw = 'Note: the symbol { means an opening brace. Result: {"ok":true}'

    expect(JSON.parse(extractJson(raw))).toEqual({ ok: true })
  })

  it('ignores a stray brace in prose that follows the real payload', () => {
    const raw = '{"ok":true} ... in curly braces like this }'

    expect(JSON.parse(extractJson(raw))).toEqual({ ok: true })
  })

  it('recovers a fenced block with a language tag', () => {
    const raw = '```json\n{"ok":true}\n```'

    expect(JSON.parse(extractJson(raw))).toEqual({ ok: true })
  })

  it('recovers an array payload', () => {
    const raw = 'Here you go: [1,2,3] thanks.'

    expect(JSON.parse(extractJson(raw))).toEqual([1, 2, 3])
  })

  it('handles nested braces', () => {
    const raw = 'prose { garbage } more prose {"a":{"b":{"c":1}}} trailing'

    expect(JSON.parse(extractJson(raw))).toEqual({ a: { b: { c: 1 } } })
  })

  it('returns the trimmed input unchanged for an empty response', () => {
    expect(extractJson('')).toBe('')
  })

  it('returns something for truncated input, and it still fails to parse (retry budget kicks in)', () => {
    const result = extractJson('{"ok":true, "incomplete":')
    expect(() => JSON.parse(result)).toThrow()
  })

  it('prefers the later of two complete JSON objects inside a single fenced block', () => {
    const raw = 'Format example:\n```json\n{"note":"example"}\n{"result":"real"}\n```'

    expect(JSON.parse(extractJson(raw))).toEqual({ result: 'real' })
  })

  it('prefers the later of two complete JSON objects in unfenced prose (placeholder-echo regression)', () => {
    const raw = `Okay, the user wants me to respond with JSON only:
{ "entities": ["<article title>", "..."] }

Thinking about Venus and radar astronomy, my answer is:
{ "entities": ["Venus", "Radar astronomy", "Tidal locking"] }`

    expect(JSON.parse(extractJson(raw))).toEqual({
      entities: ['Venus', 'Radar astronomy', 'Tidal locking'],
    })
  })
})

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

  it('passes numCtx through, the same way temperature and maxTokens are passed', async () => {
    const client = clientReturning('x')
    const provider = new OllamaLlmProvider({ client, model: 'test-model' })

    await provider.complete('hello', { numCtx: 16384 })

    expect(client.calls[0]).toMatchObject({ numCtx: 16384 })
  })

  it('omits numCtx when not given', async () => {
    const client = clientReturning('x')
    const provider = new OllamaLlmProvider({ client, model: 'test-model' })

    await provider.complete('hello')

    expect(client.calls[0]).not.toHaveProperty('numCtx')
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

  it('gives up on an empty response and still names the schema', async () => {
    const client = clientReturning('')
    const provider = new OllamaLlmProvider({ client, model: 'm', jsonAttempts: 1 })

    await expect(provider.json('p', 'Thing', parseThing)).rejects.toThrow(/Thing/)
  })

  it('gives up on a truncated response and still names the schema', async () => {
    const client = clientReturning('{"ok":true, "incomplete":')
    const provider = new OllamaLlmProvider({ client, model: 'm', jsonAttempts: 1 })

    await expect(provider.json('p', 'Thing', parseThing)).rejects.toThrow(/Thing/)
  })

  it('passes temperature and maxTokens through to every attempt', async () => {
    const client = clientReturning('{"ok":true}')
    const provider = new OllamaLlmProvider({ client, model: 'm' })

    await provider.json('p', 'Thing', parseThing, { temperature: 0.1, maxTokens: 500 })

    expect(client.calls[0]).toMatchObject({ temperature: 0.1, maxTokens: 500, json: true })
  })

  it('passes numCtx through to every attempt, the same way temperature and maxTokens are passed', async () => {
    const client = clientReturning('not json', '{"ok":true}')
    const provider = new OllamaLlmProvider({ client, model: 'm' })

    await provider.json('p', 'Thing', parseThing, { numCtx: 16384 })

    expect(client.calls).toHaveLength(2)
    expect(client.calls[0]).toMatchObject({ numCtx: 16384 })
    expect(client.calls[1]).toMatchObject({ numCtx: 16384 })
  })

  it('omits temperature, maxTokens, and numCtx when no opts are given', async () => {
    const client = clientReturning('{"ok":true}')
    const provider = new OllamaLlmProvider({ client, model: 'm' })

    await provider.json('p', 'Thing', parseThing)

    expect(client.calls[0]).not.toHaveProperty('temperature')
    expect(client.calls[0]).not.toHaveProperty('maxTokens')
    expect(client.calls[0]).not.toHaveProperty('numCtx')
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
