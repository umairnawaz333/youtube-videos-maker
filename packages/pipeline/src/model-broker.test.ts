import { describe, expect, it, vi } from 'vitest'
import { ModelBroker, type Evictable } from '@yt/pipeline'

const evictable = (id: 'llm' | 'sd') => {
  const unload = vi.fn(async () => {})
  return { evictable: { id, unload } satisfies Evictable, unload }
}

describe('ModelBroker', () => {
  it('starts with nothing resident', () => {
    const broker = new ModelBroker([])
    expect(broker.resident).toBeNull()
  })

  it('marks a model resident once acquired', async () => {
    const llm = evictable('llm')
    const broker = new ModelBroker([llm.evictable])

    const lease = await broker.acquire('llm')
    expect(broker.resident).toBe('llm')
    lease.release()
  })

  it('does not unload anything when re-acquiring the resident model', async () => {
    const llm = evictable('llm')
    const broker = new ModelBroker([llm.evictable])

    ;(await broker.acquire('llm')).release()
    ;(await broker.acquire('llm')).release()

    expect(llm.unload).not.toHaveBeenCalled()
  })

  it('evicts the resident model before admitting a different one', async () => {
    const llm = evictable('llm')
    const sd = evictable('sd')
    const broker = new ModelBroker([llm.evictable, sd.evictable])

    ;(await broker.acquire('llm')).release()
    ;(await broker.acquire('sd')).release()

    expect(llm.unload).toHaveBeenCalledTimes(1)
    expect(sd.unload).not.toHaveBeenCalled()
    expect(broker.resident).toBe('sd')
  })

  it("leaves the resident model untouched for a 'none' requirement", async () => {
    const llm = evictable('llm')
    const broker = new ModelBroker([llm.evictable])

    ;(await broker.acquire('llm')).release()
    ;(await broker.acquire('none')).release()

    expect(llm.unload).not.toHaveBeenCalled()
    expect(broker.resident).toBe('llm')
  })

  it('performs exactly two evictions across the full stage sequence', async () => {
    const llm = evictable('llm')
    const sd = evictable('sd')
    const broker = new ModelBroker([llm.evictable, sd.evictable])
    const sequence: Array<'llm' | 'sd' | 'none'> = [
      'llm', 'llm', 'llm', 'llm', 'llm', 'llm',
      'sd', 'sd',
      'none', 'none', 'none', 'none', 'none', 'none',
    ]

    for (const req of sequence) {
      ;(await broker.acquire(req)).release()
    }

    // llm evicted once when sd arrives; sd evicted once by evictAll at the end.
    expect(llm.unload).toHaveBeenCalledTimes(1)
    await broker.evictAll()
    expect(sd.unload).toHaveBeenCalledTimes(1)
    expect(broker.resident).toBeNull()
  })

  it('serialises concurrent acquisitions so two models never overlap', async () => {
    const llm = evictable('llm')
    const sd = evictable('sd')
    const broker = new ModelBroker([llm.evictable, sd.evictable])
    const observed: string[] = []

    const first = broker.acquire('llm').then(async (lease) => {
      observed.push('llm-start')
      await new Promise((r) => setTimeout(r, 20))
      observed.push('llm-end')
      lease.release()
    })

    const second = broker.acquire('sd').then((lease) => {
      observed.push('sd-start')
      lease.release()
    })

    await Promise.all([first, second])
    expect(observed).toEqual(['llm-start', 'llm-end', 'sd-start'])
  })

  it('releases the lock even when the caller throws', async () => {
    const llm = evictable('llm')
    const broker = new ModelBroker([llm.evictable])

    const lease = await broker.acquire('llm')
    try {
      throw new Error('stage blew up')
    } catch {
      lease.release()
    }

    // If the lock leaked, this would hang rather than resolve.
    await expect(broker.acquire('llm')).resolves.toBeDefined()
  })

  it('throws when asked for a model it was not given', async () => {
    const broker = new ModelBroker([])
    await expect(broker.acquire('llm')).rejects.toThrow(/no evictable registered for 'llm'/)
  })
})
