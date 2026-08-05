import type { TopicCandidate } from '@yt/core'

/**
 * Scores candidates and picks one. The four dimensions come from spec section 4 stage 1.
 * The angle is requested here rather than left to the script writer, so the run commits to
 * a specific take before any research happens.
 */
export const buildTopicScoutPrompt = (input: {
  candidates: TopicCandidate[]
  nicheLabel: string
  promptGuidance: string
}): string => {
  const list = input.candidates
    .map((c, i) => `${i + 1}. [key: ${c.key}] ${c.title}`)
    .join('\n')

  return `You are selecting the subject of one YouTube video for a channel about ${input.nicheLabel}.

Channel guidance: ${input.promptGuidance}

Score each candidate below from 0 to 10 on four dimensions:
- curiosity: how strongly the subject makes a viewer want the answer
- explainability: how well it can be explained in a few minutes without visuals of the real thing
- visualPotential: how much there is to show, illustrate, map or chart
- evergreen: how likely someone still searches for this in two years

Then choose the single best candidate and state the specific angle the video should take. The
angle must be one concrete sentence naming what the video follows — an object, a measurement,
a decision, a conflict — not a restatement of the title and not a generic promise.

Candidates:
${list}

Respond with JSON only, in exactly this shape:
{
  "candidates": [
    { "key": "<the key given above>", "title": "<title>", "scores": { "curiosity": 0, "explainability": 0, "visualPotential": 0, "evergreen": 0 }, "total": 0 }
  ],
  "chosenKey": "<key of the best candidate>",
  "angle": "<one concrete sentence>"
}

"total" must be the sum of the four scores. Include every candidate. Use only keys from the list.`
}
