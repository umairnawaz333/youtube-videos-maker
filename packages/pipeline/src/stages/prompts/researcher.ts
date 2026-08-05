/**
 * Asks which entities to research. Naming the angle matters: for "why Venus rotates
 * backwards" the useful entities include radar astronomy and tidal locking, none of which
 * follow from the title alone.
 *
 * The `title` is the video's working title, which is frequently phrased as a news headline
 * ("NASA's PUNCH Sharpens Solar Storm Forecasting in First Test") rather than an encyclopedia
 * article title — looking that raw headline up on Wikipedia is what produced a real run's
 * worst grounding failure (it resolved to "Brown dwarf", a real but wholly unrelated page).
 * So the model is asked to name the actual encyclopedic subject first, separately from the
 * headline's own wording, and that subject — not the raw title — is what the researcher is
 * guaranteed to look up.
 */
export const buildEntityPrompt = (input: { title: string; angle: string }): string =>
  `A video is being made with this working title and angle.

Working title: ${input.title}
Angle: ${input.angle}

The working title may be phrased as a news headline rather than an encyclopedia article title
(a headline like "NASA's PUNCH Sharpens Solar Storm Forecasting in First Test" is about the
mission, whose encyclopedia article is titled "Polarimeter to Unify the Corona and
Heliosphere" — not the headline's own wording). First name the single encyclopedia article
title that actually covers the working title's subject: the mission, technology, person, or
phenomenon it is about.

Then list AT MOST 4 more encyclopedia article titles for closely related entities the angle
depends on — a measurement technique, a person, a place, a competing explanation. Do not list
broad categories like "astronomy" or "history"; list specific article titles.

Only name an article you are confident actually exists with that exact title. If the working
title is a specific recent event with no verified background available, prefer its established
parent topic (the mission, the technology, the underlying phenomenon) over inventing a specific
person, study, or theory to fit the story.

Respond with JSON only:
{ "subject": "<encyclopedia article title for the working title's actual subject>", "entities": ["<related article title>", "..."] }`
