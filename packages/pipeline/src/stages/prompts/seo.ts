import { MAX_DESCRIPTION_CHARS, MAX_TITLE_CHARS } from '@yt/core'

export const buildSeoPrompt = (input: {
  topicTitle: string
  angle: string
  beats: string[]
  seoRules: string
}): string => `Write the YouTube metadata for this video.

Subject: ${input.topicTitle}
Angle: ${input.angle}
Channel SEO rules: ${input.seoRules}

Produce exactly 20 title candidates. Vary the approach across them — a question, a number, a
counterintuitive statement, a plain descriptive one. Score each from 0 to 10 on:
- curiosity: does it make someone need the answer
- searchIntent: would someone actually type this
- simplicity: is it instantly readable at a glance
- ctr: would it earn the click against similar videos

Every title must be at most ${MAX_TITLE_CHARS} characters. Do not use ALL CAPS or clickbait
that the video does not deliver on.

Also write a description of at most ${MAX_DESCRIPTION_CHARS} characters that says what the
video covers in its first two lines, then a short list of the sections. Add up to 15 tags
(plain lowercase keywords, no "#") and up to 5 hashtags (with "#").

NARRATION, for context:
${input.beats.map((b, i) => `[${i + 1}] ${b}`).join('\n')}

Respond with JSON only:
{
  "titles": [ { "title": "<text>", "scores": { "curiosity": 0, "searchIntent": 0, "simplicity": 0, "ctr": 0 }, "total": 0 } ],
  "description": "<text>",
  "tags": ["keyword"],
  "hashtags": ["#keyword"]
}

"total" must be the sum of the four scores. Provide all 20 titles.`
