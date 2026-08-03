import type { ModelRequirement } from '@yt/core'

export interface Evictable {
  readonly id: 'llm' | 'sd'
  unload(): Promise<void>
}

export interface ModelLease {
  release(): void
}

/**
 * Guarantees at most one heavy model is memory-resident.
 *
 * The target machine has 16 GB of unified memory. An 8B LLM (~6 GB) and SDXL (~8 GB)
 * cannot coexist alongside a rendering Chromium (~3 GB), so admission is serialised and
 * a differing request evicts the incumbent first.
 */
export class ModelBroker {
  private readonly evictables: Map<'llm' | 'sd', Evictable>
  private current: 'llm' | 'sd' | null = null
  /** Tail of the FIFO admission queue. Each acquire chains onto the previous one. */
  private tail: Promise<void> = Promise.resolve()

  constructor(evictables: Evictable[]) {
    this.evictables = new Map(evictables.map((e) => [e.id, e]))
  }

  get resident(): 'llm' | 'sd' | null {
    return this.current
  }

  async acquire(requirement: ModelRequirement): Promise<ModelLease> {
    // A stage needing no model must not queue behind model work.
    if (requirement === 'none') {
      return { release: () => {} }
    }

    const evictable = this.evictables.get(requirement)
    if (!evictable) {
      throw new Error(`ModelBroker: no evictable registered for '${requirement}'`)
    }

    let releaseLock!: () => void
    const held = new Promise<void>((resolve) => {
      releaseLock = resolve
    })

    const waitFor = this.tail
    this.tail = waitFor.then(() => held)
    await waitFor

    try {
      if (this.current !== null && this.current !== requirement) {
        const incumbent = this.evictables.get(this.current)
        if (incumbent) await incumbent.unload()
        this.current = null
      }
      this.current = requirement
    } catch (err) {
      // A rejecting unload() must not leave `held` (and therefore `this.tail`)
      // stuck forever — that would deadlock every future acquire(). We release
      // the lock here on the failure path specifically (a bare `finally` would
      // also fire on the success path, unlocking before the caller's lease is
      // released and letting the next queued acquire proceed concurrently with
      // this one — reintroducing double residency). `this.current` is left
      // untouched: the incumbent genuinely is still loaded, so reporting it as
      // resident is correct (fail closed on the memory invariant).
      releaseLock()
      throw err
    }

    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        releaseLock()
      },
    }
  }

  /** Frees all model memory. Call at the end of a run, or before rendering. */
  async evictAll(): Promise<void> {
    // Routed through the same FIFO chain as acquire(). Without this, evictAll
    // could read `this.current` while an admission is in-flight (suspended in
    // `await incumbent.unload()` inside acquire()), then null out residency
    // from under a lease that was just granted — `resident` would lie (stale
    // null while a model is actually loaded and in use), and a concurrent
    // acquire() could also call unload() on the same incumbent a second time.
    let releaseLock!: () => void
    const held = new Promise<void>((resolve) => {
      releaseLock = resolve
    })

    const waitFor = this.tail
    this.tail = waitFor.then(() => held)
    await waitFor

    try {
      // Re-read `this.current` only now — after our turn in the queue — so we
      // never act on a value that a concurrently-queued acquire() might still
      // be in the middle of changing.
      if (this.current !== null) {
        const incumbent = this.evictables.get(this.current)
        if (incumbent) await incumbent.unload()
        this.current = null
      }
    } finally {
      // Unlike acquire(), evictAll() never hands out a lease for the caller to
      // hold onward — the operation is complete (success or failure) by the
      // time this function returns, so it is always correct to release the
      // lock here.
      releaseLock()
    }
  }
}
