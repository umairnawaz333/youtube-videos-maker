import { MAX_DESCRIPTION_CHARS, MAX_TITLE_CHARS } from '@yt/core'

/**
 * A batch of title candidates only — never all 20 at once. Asking a local model for 20 scored
 * titles in a single JSON-constrained call produced the exact same failure TopicScout hit
 * against a large candidate list: a hallucinated `{"error": "..."}` refusal instead of doing
 * the task. Requesting a handful at a time keeps each call's output small enough to complete.
 */
export const buildSeoTitlesPrompt = (input: {
  topicTitle: string
  angle: string
  count: number
  /**
   * Titles already accepted from an earlier batch in the same run. Passed back in so a later
   * batch call is nudged away from repeating them — a near-greedy model otherwise tends to
   * return its handful of best titles again on every batch, which the stage still has to
   * de-duplicate and, if too many, retry for.
   */
  avoid?: string[]
}): string => `Write ${input.count} YouTube title candidates for this video.

Subject: ${input.topicTitle}
Angle: ${input.angle}

Vary the approach across them — a question, a number, a counterintuitive statement, a plain
descriptive one. Score each from 0 to 10 on:
- curiosity: does it make someone need the answer
- searchIntent: would someone actually type this
- simplicity: is it instantly readable at a glance
- ctr: would it earn the click against similar videos

Every title must be at most ${MAX_TITLE_CHARS} characters. Do not use ALL CAPS or clickbait that
the video does not deliver on.
${
  input.avoid && input.avoid.length > 0
    ? `\nDo not repeat, or write a close variant of, any of these titles already used:\n${input.avoid.map((t) => `- ${t}`).join('\n')}\n`
    : ''
}
Respond with JSON only:
{ "titles": [ { "title": "<text>", "scores": { "curiosity": 0, "searchIntent": 0, "simplicity": 0, "ctr": 0 } } ] }

Provide exactly ${input.count} titles.`

/** Description, tags and hashtags only — kept separate from title generation so neither call
 * has to carry both a long narration excerpt and twenty scored titles at once. */
export const buildSeoMetadataPrompt = (input: {
  topicTitle: string
  angle: string
  beats: string[]
  seoRules: string
}): string => `Write the YouTube description, tags and hashtags for this video.

Subject: ${input.topicTitle}
Angle: ${input.angle}
Channel SEO rules: ${input.seoRules}

Write a description of at most ${MAX_DESCRIPTION_CHARS} characters that says what the video
covers in its first two lines, then a short list of the sections. Add up to 15 tags (plain
lowercase keywords, no "#") and up to 5 hashtags (with "#").

NARRATION, for context:
${input.beats.map((b, i) => `[${i + 1}] ${b}`).join('\n')}

Respond with JSON only:
{ "description": "<text>", "tags": ["keyword"], "hashtags": ["#keyword"] }`
