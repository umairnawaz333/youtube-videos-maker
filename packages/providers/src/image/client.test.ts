import { describe, expect, it, vi } from 'vitest'
import { createHttpImageGenClient } from './client'

const fakeFetch = (init: { body?: Buffer; status?: number; statusText?: string } = {}) =>
  vi.fn(
    async () =>
      new Response(init.body ?? Buffer.from([1, 2, 3]), {
        status: init.status ?? 200,
        statusText: init.statusText ?? 'OK',
      }),
  ) as unknown as typeof fetch

describe('createHttpImageGenClient', () => {
  it('posts prompt/width/height/seed to /generate and returns the response bytes', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const fetchImpl = fakeFetch({ body: pngBytes })
    const client = createHttpImageGenClient({ host: 'http://127.0.0.1:8000', fetchImpl })

    const result = await client.generate({ prompt: 'a nebula', width: 1024, height: 1024, seed: 42 })

    expect(result).toEqual(pngBytes)
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(call[0]).toBe('http://127.0.0.1:8000/generate')
    const requestBody = JSON.parse((call[1] as RequestInit).body as string)
    expect(requestBody).toEqual({ prompt: 'a nebula', width: 1024, height: 1024, seed: 42 })
  })

  it('forwards steps only when given', async () => {
    const fetchImpl = fakeFetch()
    const client = createHttpImageGenClient({ host: 'http://127.0.0.1:8000', fetchImpl })

    await client.generate({ prompt: 'p', width: 1024, height: 1024, seed: 1, steps: 4 })

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    const requestBody = JSON.parse((call[1] as RequestInit).body as string)
    expect(requestBody.steps).toBe(4)
  })

  it('strips a trailing slash from the host', async () => {
    const fetchImpl = fakeFetch()
    const client = createHttpImageGenClient({ host: 'http://127.0.0.1:8000/', fetchImpl })

    await client.generate({ prompt: 'p', width: 1024, height: 1024, seed: 1 })

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(call[0]).toBe('http://127.0.0.1:8000/generate')
  })

  it('throws a descriptive, non-ok error naming the failing endpoint and status', async () => {
    const fetchImpl = fakeFetch({ status: 500, statusText: 'Internal Server Error' })
    const client = createHttpImageGenClient({ host: 'http://127.0.0.1:8000', fetchImpl })

    await expect(client.generate({ prompt: 'p', width: 1024, height: 1024, seed: 1 })).rejects.toThrow(
      /500.*\/generate/s,
    )
  })

  it('names the command to start the service when the sidecar is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch failed')
    }) as unknown as typeof fetch
    const client = createHttpImageGenClient({ host: 'http://127.0.0.1:8000', fetchImpl })

    await expect(client.generate({ prompt: 'p', width: 1024, height: 1024, seed: 1 })).rejects.toThrow(
      /pnpm imagegen:serve/,
    )
  })

  it('posts to /unload and resolves on success', async () => {
    const fetchImpl = fakeFetch()
    const client = createHttpImageGenClient({ host: 'http://127.0.0.1:8000', fetchImpl })

    await client.unload()

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(call[0]).toBe('http://127.0.0.1:8000/unload')
    expect((call[1] as RequestInit).method).toBe('POST')
  })

  it('names the command to start the service when unload cannot reach the sidecar', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch failed')
    }) as unknown as typeof fetch
    const client = createHttpImageGenClient({ host: 'http://127.0.0.1:8000', fetchImpl })

    await expect(client.unload()).rejects.toThrow(/pnpm imagegen:serve/)
  })
})
