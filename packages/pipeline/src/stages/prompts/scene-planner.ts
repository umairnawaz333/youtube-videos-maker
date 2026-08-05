import { CAMERA_MOVES } from '@yt/core'

export const buildScenePlanPrompt = (input: {
  beats: { id: string; text: string; sectionKind: string }[]
  styleSuffix: string
  imageBudget: number
  clipBudget: number
  clipSections: string[]
}): string => `Plan the visuals for a narrated video. One scene per beat.

For each scene choose exactly one visual:
- "sd-image": a generated still. Write an image prompt describing a concrete subject, setting
  and lighting. Never describe text, captions or words in the image.
- "motion-graphic": data rather than a photograph. Pick a variant: timeline, map, stat, quote, list.
- "reuse": show an earlier scene's image again under a different camera move.
- "veo-clip": a short generated video clip. Only for high-impact moments.

Also choose a camera move from: ${CAMERA_MOVES.join(', ')}.

BUDGETS — these are hard limits:
- at most ${input.imageBudget} scenes may be "sd-image"
- at most ${input.clipBudget} scenes may be "veo-clip", and only in these sections: ${input.clipSections.join(', ')}
- use "reuse" and "motion-graphic" for the rest; a video that is only generated stills looks like a slideshow

Every image prompt must end with this style, so the video looks like one piece: ${input.styleSuffix}

BEATS:
${input.beats.map((b) => `[${b.id}] (${b.sectionKind}) ${b.text}`).join('\n')}

Respond with JSON only:
{
  "scenes": [
    {
      "id": "scene-1",
      "beatId": "<the beat id above>",
      "visual": { "kind": "sd-image", "prompt": "<image prompt>, ${input.styleSuffix}" },
      "camera": "zoom-in"
    }
  ]
}

For "motion-graphic" use { "kind": "motion-graphic", "variant": "timeline", "payload": {} }.
For "reuse" use { "kind": "reuse", "sceneId": "<an earlier scene id>" }.
For "veo-clip" use { "kind": "veo-clip", "prompt": "<motion description>", "referenceSceneId": "<an earlier scene id>", "fallbackPrompt": "<a still image prompt to use if no clip arrives>" }.
Produce exactly one scene per beat, in beat order.`
