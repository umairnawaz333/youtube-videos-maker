import { SECTION_KINDS } from '@yt/core'

/**
 * Words per beat are derived from a single beat's length, not from the whole video divided by
 * beat count — those differ, and the latter produced an instruction to write 16 words for a
 * beat that must last at least 15 seconds (~37 words), which is unsatisfiable.
 */
const SECONDS_PER_BEAT_HINT = 22

/**
 * The beat budget is stated explicitly because a local model asked for "about nine minutes"
 * produces wildly variable length. Telling it the section count, the per-section beat count
 * and the seconds per beat turns the length target into arithmetic it can follow.
 */
export const buildScriptPrompt = (input: {
  topicTitle: string
  angle: string
  facts: string[]
  targetSeconds: number
  beatsPerSection: number
}): string => {
  const factList = input.facts.map((f, i) => `${i + 1}. ${f}`).join('\n')
  const totalBeats = input.beatsPerSection * SECTION_KINDS.length

  return `Write the narration script for one YouTube video.

Subject: ${input.topicTitle}
Angle: ${input.angle}

STRUCTURE — exactly these ${SECTION_KINDS.length} sections, in this order:
${SECTION_KINDS.map((k, i) => `${i + 1}. ${k}`).join('\n')}

Each section contains beats. A beat is one spoken unit that introduces something new.

LENGTH — the whole video runs about ${input.targetSeconds} seconds:
- ${input.beatsPerSection} beats per section, so about ${totalBeats} beats in total
- every beat's targetSeconds MUST be between 15 and 30 inclusive
- write roughly ${Math.round(SECONDS_PER_BEAT_HINT * 2.5)} words of narration per beat, since speech runs about 150 words per minute
- use only these values for targetSeconds: 15, 20, 25 or 30

GROUNDING — you may only state things supported by these facts. Do not add dates, numbers,
names or causes that are not here. If a fact you want is missing, write around it.
${factList}

WRITING — this is spoken narration, not an essay. No headings, no bullet points, no stage
directions, no "in this video". Every beat must introduce something new: a question, a
complication, a reveal, a consequence. The hook has one job, which is making the next beat
unskippable.

Respond with JSON only:
{
  "topicTitle": "${input.topicTitle}",
  "sections": [
    { "kind": "hook", "beats": [ { "id": "hook-1", "text": "<narration>", "targetSeconds": 20 } ] }
  ]
}

Include all ${SECTION_KINDS.length} sections. Give every beat a unique id.`
}
