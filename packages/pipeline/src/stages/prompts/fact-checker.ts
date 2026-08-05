export const buildFactCheckPrompt = (input: { beats: string[]; facts: string[] }): string => `You are fact-checking narration against the only sources permitted for it.

Extract every factual claim the narration makes — a date, a number, a cause, an attribution, a
superlative. Rhetorical questions and opinions are not claims. Then judge each claim against
the facts below and nothing else. Your own knowledge does not count as support here: the point
is whether the script is grounded in its sources.

Verdicts:
- "supported": the facts state this, or it follows directly from them
- "unsupported": the facts neither state nor contradict it
- "contradicted": the facts say otherwise

NARRATION:
${input.beats.map((b, i) => `[${i + 1}] ${b}`).join('\n')}

PERMITTED FACTS:
${input.facts.map((f, i) => `(${i + 1}) ${f}`).join('\n')}

Respond with JSON only:
{
  "claims": [
    { "text": "<the claim, quoted or closely paraphrased>", "verdict": "supported", "sourceFact": <the number in parentheses of the fact that supports this claim, omit unless supported> }
  ]
}

Include every claim you found. Do not include a sourceFact for an unsupported or contradicted claim.`
