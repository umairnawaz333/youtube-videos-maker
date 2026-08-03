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

    if (this.current !== null && this.current !== requirement) {
      const incumbent = this.evictables.get(this.current)
      if (incumbent) await incumbent.unload()
      this.current = null
    }
    this.current = requirement

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
    if (this.current === null) return
    const incumbent = this.evictables.get(this.current)
    if (incumbent) await incumbent.unload()
    this.current = null
  }
}
