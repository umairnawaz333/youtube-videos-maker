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
- evergreen: how likely someone still searches for this in two years — a well-established subject
  with years of prior coverage scores high here; a single still-developing news item you have no
  real background on scores low, even if it sounds exciting, because the video cannot be
  accurately researched or fact-checked without that background

Score a recurring trivia, quiz, "guess what this is," or puzzle-style feature low on evergreen
and explainability regardless of how curious it sounds — there is nothing behind the title
itself to research, so a video about it cannot be grounded in real sources.

Then choose the single best candidate and state the specific angle the video should take. The
angle must be one concrete sentence naming what the video follows — an object, a measurement,
a decision, a conflict — not a restatement of the title and not a generic promise. The angle
must be about the same candidate you are choosing, never a different one from your scored list.

Candidates:
${list}

Respond with JSON only, in exactly this shape:
{
  "candidates": [
    { "key": "<the key given above>", "scores": { "curiosity": 0, "explainability": 0, "visualPotential": 0, "evergreen": 0 } }
  ],
  "chosen": { "key": "<key of the best candidate, matching one of the keys above>", "angle": "<one concrete sentence, about that same candidate>" }
}

Include every candidate, in the same order, using only keys from the list above.`
}
