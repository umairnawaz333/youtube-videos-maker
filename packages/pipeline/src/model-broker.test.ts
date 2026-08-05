import { describe, expect, it, vi } from 'vitest'
import { STAGE_NAMES, STAGE_REQUIREMENTS } from '@yt/core'
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

  it('serialises concurrent acquisitions deterministically, proving eviction happens strictly between the two leases', async () => {
    const observed: string[] = []
    const llmUnload = vi.fn(async () => {
      observed.push('llm-unload')
    })
    const sdUnload = vi.fn(async () => {
      observed.push('sd-unload')
    })
    const llmEvictable: Evictable = { id: 'llm', unload: llmUnload }
    const sdEvictable: Evictable = { id: 'sd', unload: sdUnload }
    const broker = new ModelBroker([llmEvictable, sdEvictable])

    // A caller-controlled gate instead of a real timer: the ordering below is
    // forced by the promise dependency graph, not by wall-clock racing, so it
    // cannot be flaky regardless of how many microtask ticks each `await`
    // inside the broker actually takes.
    let openGate!: () => void
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })

    const first = broker.acquire('llm').then(async (lease) => {
      observed.push('llm-start')
      await gate
      observed.push('llm-end')
      lease.release()
    })

    const second = broker.acquire('sd').then((lease) => {
      observed.push('sd-start')
      lease.release()
    })

    // Drain every currently-pending microtask (but not a real timer) so the
    // first acquisition's synchronous-until-the-gate work has definitely run,
    // while the second remains blocked behind it in the FIFO queue.
    await new Promise((resolve) => setImmediate(resolve))
    expect(observed).toEqual(['llm-start'])

    openGate()
    await Promise.all([first, second])

    // Eviction of llm must fall strictly between the first lease ending and
    // the second one starting — never before llm-end, never after sd-start.
    expect(observed).toEqual(['llm-start', 'llm-end', 'llm-unload', 'sd-start'])
  })

  it('rejects the eviction when unload() rejects, then still admits a later acquire (no deadlock)', async () => {
    const llm = evictable('llm')
    const sd = evictable('sd')
    const broker = new ModelBroker([llm.evictable, sd.evictable])

    ;(await broker.acquire('llm')).release()

    llm.unload.mockRejectedValueOnce(new Error('unload failed'))
    await expect(broker.acquire('sd')).rejects.toThrow('unload failed')

    // Fail closed: the incumbent really is still loaded.
    expect(broker.resident).toBe('llm')

    // If the failed eviction had leaked the lock, this would hang forever
    // rather than resolve — this is the deadlock regression test.
    await expect(broker.acquire('llm')).resolves.toBeDefined()
  })

  it('evictAll() waits for a held lease before nulling residency', async () => {
    const llm = evictable('llm')
    const broker = new ModelBroker([llm.evictable])
    const order: string[] = []

    const lease = await broker.acquire('llm')
    expect(broker.resident).toBe('llm')

    const evictAllPromise = broker.evictAll().then(() => {
      order.push('evictAll-done')
    })

    // Give evictAll a chance to run ahead if it (incorrectly) bypassed the queue.
    await new Promise((resolve) => setImmediate(resolve))
    expect(broker.resident).toBe('llm')
    order.push('still-resident-checked')

    lease.release()
    await evictAllPromise

    expect(order).toEqual(['still-resident-checked', 'evictAll-done'])
    expect(llm.unload).toHaveBeenCalledTimes(1)
    expect(broker.resident).toBeNull()
  })

  it('evictAll() racing a concurrent acquire() for the same model does not double-unload or leave a stale null residency', async () => {
    const llm = evictable('llm')
    const broker = new ModelBroker([llm.evictable])

    ;(await broker.acquire('llm')).release()
    expect(llm.unload).not.toHaveBeenCalled()

    const evictAllPromise = broker.evictAll()
    const acquirePromise = broker.acquire('llm')

    const lease = await acquirePromise
    // Must not observe a stale null while this lease is live.
    expect(broker.resident).toBe('llm')

    lease.release()
    await evictAllPromise

    expect(llm.unload).toHaveBeenCalledTimes(1)
  })

  it('release() is idempotent: a second call does not double-unlock the queue', async () => {
    const llm = evictable('llm')
    const broker = new ModelBroker([llm.evictable])

    const lease = await broker.acquire('llm')
    lease.release()
    lease.release()

    await expect(broker.acquire('llm')).resolves.toBeDefined()
  })

  it('evictAll() is a safe no-op with nothing resident, even called twice in a row', async () => {
    const llm = evictable('llm')
    const broker = new ModelBroker([llm.evictable])

    await broker.evictAll()
    await broker.evictAll()

    expect(llm.unload).not.toHaveBeenCalled()
    expect(broker.resident).toBeNull()
  })

  it("acquire('none') resolves immediately even while a model lease is held", async () => {
    const llm = evictable('llm')
    const broker = new ModelBroker([llm.evictable])

    const lease = await broker.acquire('llm')

    // If 'none' queued behind the still-held llm lease, this would hang.
    const noneLease = await broker.acquire('none')
    noneLease.release()

    expect(broker.resident).toBe('llm')
    lease.release()
  })
})

describe('ModelBroker exclusive requirement', () => {
  it('evicts the resident model and leaves nothing resident', async () => {
    const llm = evictable('llm')
    const sd = evictable('sd')
    const broker = new ModelBroker([llm.evictable, sd.evictable])

    ;(await broker.acquire('sd')).release()
    expect(broker.resident).toBe('sd')

    const lease = await broker.acquire('exclusive')
    expect(sd.unload).toHaveBeenCalledTimes(1)
    expect(broker.resident).toBeNull()
    lease.release()
  })

  it('is a no-op eviction when nothing is resident', async () => {
    const llm = evictable('llm')
    const broker = new ModelBroker([llm.evictable])

    ;(await broker.acquire('exclusive')).release()

    expect(llm.unload).not.toHaveBeenCalled()
    expect(broker.resident).toBeNull()
  })

  it('queues behind a held lease rather than evicting underneath it', async () => {
    const llm = evictable('llm')
    const broker = new ModelBroker([llm.evictable])
    const observed: string[] = []

    const held = await broker.acquire('llm')
    const exclusive = broker.acquire('exclusive').then((lease) => {
      observed.push('exclusive-admitted')
      lease.release()
    })

    await new Promise((r) => setTimeout(r, 10))
    observed.push('still-holding-llm')
    expect(broker.resident).toBe('llm')
    held.release()
    await exclusive

    expect(observed).toEqual(['still-holding-llm', 'exclusive-admitted'])
    expect(broker.resident).toBeNull()
  })

  it('does not deadlock when the eviction it triggers rejects', async () => {
    // Rejects once (the exclusive eviction below), then succeeds — mirroring the
    // pre-existing 'rejects the eviction when unload() rejects' test's pattern. An
    // always-throwing unload would make the deadlock-regression assertion below
    // (acquire('llm'), which must evict the still-resident 'sd') reject a second
    // time too, since a failed eviction fails closed and leaves 'sd' resident.
    const failingUnload = vi.fn(async () => {})
    failingUnload.mockRejectedValueOnce(new Error('sd unload failed'))
    const failing: Evictable = { id: 'sd', unload: failingUnload }
    const llm = evictable('llm')
    const broker = new ModelBroker([failing, llm.evictable])

    ;(await broker.acquire('sd')).release()
    await expect(broker.acquire('exclusive')).rejects.toThrow('sd unload failed')

    // The lock must have been released, so the broker is still usable.
    const after = await broker.acquire('llm')
    expect(broker.resident).toBe('llm')
    after.release()
  })

  it('performs exactly two unloads across the full stage sequence, with SD gone before narration', async () => {
    const llm = evictable('llm')
    const sd = evictable('sd')
    const broker = new ModelBroker([llm.evictable, sd.evictable])
    let residentAtNarrator: string | null = 'unset' as unknown as string | null

    for (const name of STAGE_NAMES) {
      const lease = await broker.acquire(STAGE_REQUIREMENTS[name])
      if (name === 'narrator') residentAtNarrator = broker.resident
      lease.release()
    }

    expect(llm.unload).toHaveBeenCalledTimes(1)
    expect(sd.unload).toHaveBeenCalledTimes(1)
    // The whole point: no heavy model is resident once narration starts.
    expect(residentAtNarrator).toBeNull()
    await broker.evictAll()
    expect(broker.resident).toBeNull()
  })
})
