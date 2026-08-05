import { describe, expect, it, vi } from 'vitest'
import { createHttpOllamaClient } from './client'

const fakeFetch = (body: unknown = { response: 'ok' }) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch

describe('createHttpOllamaClient', () => {
  it('forwards numCtx as num_ctx in the options object, alongside temperature and num_predict', async () => {
    const fetchImpl = fakeFetch()
    const client = createHttpOllamaClient({ host: 'http://127.0.0.1:11434', fetchImpl })

    await client.generate({
      model: 'm',
      prompt: 'p',
      json: true,
      temperature: 0.2,
      maxTokens: 64,
      numCtx: 16384,
    })

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    const requestBody = JSON.parse((call[1] as RequestInit).body as string)
    expect(requestBody.options).toEqual({ temperature: 0.2, num_predict: 64, num_ctx: 16384 })
  })

  it('omits num_ctx from options when numCtx is not given', async () => {
    const fetchImpl = fakeFetch()
    const client = createHttpOllamaClient({ host: 'http://127.0.0.1:11434', fetchImpl })

    await client.generate({ model: 'm', prompt: 'p', json: false })

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    const requestBody = JSON.parse((call[1] as RequestInit).body as string)
    expect(requestBody.options).not.toHaveProperty('num_ctx')
  })
})
