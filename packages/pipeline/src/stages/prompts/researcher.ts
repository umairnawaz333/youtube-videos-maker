/**
 * Asks which entities to research. Naming the angle matters: for "why Venus rotates
 * backwards" the useful entities include radar astronomy and tidal locking, none of which
 * follow from the title alone.
 */
export const buildEntityPrompt = (input: { title: string; angle: string }): string =>
  `A video is being made with this subject and angle.

Subject: ${input.title}
Angle: ${input.angle}

List the encyclopedia article titles that would need to be read to explain this accurately.
Include the subject itself and between two and five closely related entities that the angle
depends on — a measurement technique, a person, a place, a competing explanation. Do not list
broad categories like "astronomy" or "history"; list specific article titles.

Respond with JSON only:
{ "entities": ["<article title>", "..."] }`
