import { describe, expect, it } from 'vitest'
import type { ResearchFact } from '@yt/core'
import { selectFactsForPrompt } from './facts'

const makeFacts = (n: number): ResearchFact[] =>
  Array.from({ length: n }, (_, i) => ({ text: `Fact ${i + 1}.`, sourceUrl: `https://example.com/${i + 1}` }))

describe('selectFactsForPrompt', () => {
  it('takes a leading slice of the given size when the corpus exceeds the cap', () => {
    const facts = makeFacts(10)
    const selected = selectFactsForPrompt(facts, 3)
    expect(selected.map((f) => f.text)).toEqual(['Fact 1.', 'Fact 2.', 'Fact 3.'])
  })

  it('returns the whole corpus unchanged when it is at or below the cap', () => {
    const facts = makeFacts(5)
    expect(selectFactsForPrompt(facts, 5)).toEqual(facts)
    expect(selectFactsForPrompt(facts, 100)).toEqual(facts)
  })

  it('returns an empty array for an empty corpus regardless of cap', () => {
    expect(selectFactsForPrompt([], 10)).toEqual([])
  })

  it('preserves original order rather than sorting or reversing', () => {
    const facts = makeFacts(20)
    const selected = selectFactsForPrompt(facts, 8)
    expect(selected).toEqual(facts.slice(0, 8))
  })

  it('given the same corpus and cap twice, produces byte-identical results both times -- the invariant both stages rely on', () => {
    const facts = makeFacts(40)
    const first = selectFactsForPrompt(facts, 15)
    const second = selectFactsForPrompt(facts, 15)
    expect(first).toEqual(second)
  })
})
