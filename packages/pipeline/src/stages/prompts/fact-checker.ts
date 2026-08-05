/**
 * Asks the model to label every extracted sentence's *type* before judging it, rather than
 * simply instructing it to skip non-factual sentences. A prior version of this prompt already
 * said "Rhetorical questions and opinions are not claims" in plain language, and a real run
 * ignored it anyway — extracting rhetorical questions ("What will it look like?"), narrative
 * framing ("This observation is more than just a scientific experiment"), and value statements
 * ("a testament to human ingenuity") as if they were checkable claims, all reported
 * "unsupported" for want of a source that could never exist for a sentence asserting nothing.
 *
 * The fix is structural, the same "ask for less, compute the rest ourselves" pattern used
 * elsewhere in this codebase (TopicScout's server-side score sums, ScenePlanner's narration
 * copy, this same stage's own sourceFact-to-sourceUrl index mapping): the model still extracts
 * every sentence, but now also names its type, and the fact-checker stage drops every
 * non-"factual" type in code before the failure ratio is ever computed — a structural filter
 * survives a model ignoring an instruction in a way a plain instruction alone did not.
 */
export const buildFactCheckPrompt = (input: { beats: string[]; facts: string[] }): string => `You are fact-checking narration against the only sources permitted for it.

Go through the narration sentence by sentence. For every sentence, decide which type it is:
- "factual": a checkable assertion — a date, a number, a cause, an attribution, a superlative,
  a claim about what happened or what something is. This is the only type that gets judged
  against the sources.
- "rhetorical": a rhetorical question aimed at the viewer ("What will it look like?", "How will
  it interact with the surface?"). Asserts nothing.
- "opinion": a value judgment, evaluation, or superlative about how something feels rather than
  what it is ("a testament to human ingenuity", "the impact itself is a mystery").
- "narrative": scene-setting, framing, or a transition between beats that asserts nothing
  checkable on its own ("This observation is more than just a scientific experiment", "The
  Moon, once a distant dream, now holds the echoes of our space ambitions").

Only extract a sentence as "factual" if a person could look it up and call it true or false.
When in doubt between "factual" and one of the other three, choose the other three — a false
positive here (calling something factual that isn't) produces a claim that can never be
supported no matter how good the sources are, since nothing in the sources could ever address a
question or a feeling. A false negative just means one real claim gets skipped, which is far
cheaper.

Then, for every sentence you labeled "factual" only, judge it against the facts below and
nothing else. Your own knowledge does not count as support here: the point is whether the
script is grounded in its sources. For every non-factual sentence, still include it in the
output with its type, but set its verdict to "supported" as a placeholder — it will not be
scored.

Verdicts (meaningful only for "factual" claims):
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
    { "text": "<the sentence, quoted or closely paraphrased>", "type": "factual", "verdict": "supported", "sourceFact": <the number in parentheses of the fact that supports this claim, omit unless supported and factual> }
  ]
}

Include every sentence you found, factual or not, each labeled with its type. Do not include a
sourceFact for a claim that is not both "factual" and "supported".`
