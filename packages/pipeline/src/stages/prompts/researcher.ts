/**
 * Asks which entities to research. Naming the angle matters: for "why Venus rotates
 * backwards" the useful entities include radar astronomy and tidal locking, none of which
 * follow from the title alone.
 */
export const buildEntityPrompt = (input: { title: string; angle: string }): string =>
  `A video is being made with this subject and angle.

Subject: ${input.title}
Angle: ${input.angle}

List AT MOST 5 encyclopedia article titles that would need to be read to explain this
accurately: the subject itself plus up to four closely related entities that the angle depends
on — a measurement technique, a person, a place, a competing explanation. Do not list broad
categories like "astronomy" or "history"; list specific article titles. Never exceed 5 entries.

Only list an entity you are confident is the exact title of an existing encyclopedia article.
If the subject is a specific recent event with no verified background available, prefer its
established parent topic (the mission, the technology, the underlying phenomenon) over inventing
a specific person, study, or theory to fit the story.

Respond with JSON only:
{ "entities": ["<article title>", "..."] }`
