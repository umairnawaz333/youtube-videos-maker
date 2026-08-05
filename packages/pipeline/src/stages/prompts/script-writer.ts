import { SECTION_KINDS } from '@yt/core'

/**
 * Words per beat are derived from a single beat's length, not from the whole video divided by
 * beat count — those differ, and the latter produced an instruction to write 16 words for a
 * beat that must last at least 15 seconds (~37 words), which is unsatisfiable.
 */
export const SECONDS_PER_BEAT_HINT = 22

/**
 * The beat budget a given run's config resolves to — shared by the script writer (which uses
 * it to build the prompt) and the researcher (which uses `totalBeats` to judge whether the
 * gathered corpus is large enough to ground the script it is about to ask for). Keeping this
 * in one place means the researcher's corpus-floor check is always judged against the exact
 * beat count the script writer will actually target, not a separately maintained copy of the
 * same arithmetic that could drift out of sync with it.
 */
export const computeBeatPlan = (config: {
  videoType: 'shorts' | 'long'
  duration: number
  preset: { minDurationSec: number; maxDurationSec: number }
}): { targetSeconds: number; beatsPerSection: number; totalBeats: number } => {
  const { minDurationSec, maxDurationSec } = config.preset
  const targetSeconds =
    config.videoType === 'shorts'
      ? Math.round((minDurationSec + maxDurationSec) / 2)
      : Math.min(maxDurationSec, Math.max(minDurationSec, Math.round(config.duration * 60)))
  const beatsPerSection = Math.max(
    1,
    Math.round(targetSeconds / (SECONDS_PER_BEAT_HINT * SECTION_KINDS.length)),
  )
  return { targetSeconds, beatsPerSection, totalBeats: beatsPerSection * SECTION_KINDS.length }
}

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
  // Total word count derives from duration x 150 wpm (spec section 4 stage 3), independent of
  // the fixed per-beat hint below -- this is the number that actually moves with `duration`.
  const totalWords = Math.round(input.targetSeconds * 2.5)

  return `Write the narration script for one YouTube video.

Subject: ${input.topicTitle}
Angle: ${input.angle}

STRUCTURE — exactly these ${SECTION_KINDS.length} sections, in this order:
${SECTION_KINDS.map((k, i) => `${i + 1}. ${k}`).join('\n')}

Each section contains beats. A beat is one spoken unit that introduces something new.

LENGTH — the whole video runs about ${input.targetSeconds} seconds (roughly ${totalWords} words total at 150 words per minute):
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
