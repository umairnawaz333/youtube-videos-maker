import { z } from 'zod'
import {
  ResearchSchema,
  STAGE_REQUIREMENTS,
  TopicSchema,
  type ResearchFact,
  type Stage,
} from '@yt/core'
import { buildEntityPrompt } from './prompts/researcher'
import { computeBeatPlan } from './prompts/script-writer'

// The prompt asks for at most 4 related entities beyond the subject, but a real run showed a
// local model occasionally ignoring that and listing well over a dozen once it starts
// enumerating a topic's related concepts. Reject only a truly pathological response (would
// indicate the model abandoned the task, the same failure mode TopicScout guards against with
// its own candidate cap) rather than burning three retries — and the whole stage's retry budget
// on top — over a merely generous list that MAX_ENTITIES_RESEARCHED below already caps before
// it does any real harm.
const EntitiesSchema = z.object({
  // The model's own best guess at the encyclopedic subject behind the (possibly headline-style)
  // working title. This, not the raw title, is what the researcher guarantees to look up —
  // looking up the raw title directly is what resolved "NASA's PUNCH Sharpens Solar Storm
  // Forecasting in First Test" to the real but wholly unrelated "Brown dwarf" in a real run.
  subject: z.string().min(1),
  entities: z.array(z.string().min(1)).max(24),
})

/** However many the model returns, only research this many — keeps the lookup count and the
 * researcher's own log line bounded regardless of how generous the model's list was. */
const MAX_ENTITIES_RESEARCHED = 6

/** Facts per entity. Enough to ground a script without burning the context window. */
const MAX_FACTS_PER_ENTITY = 8

export const createResearcherStage = (): Stage => ({
  name: 'researcher',
  requires: STAGE_REQUIREMENTS.researcher,

  async run(ctx) {
    const topic = await ctx.artifacts.read('topic', TopicSchema)

    const { subject, entities } = await ctx.providers.llm.json(
      buildEntityPrompt({ title: topic.title, angle: topic.angle }),
      'ResearchEntities',
      (raw) => EntitiesSchema.parse(raw),
      { temperature: ctx.config.llm.temperature },
    )

    // The model's extracted subject is the guarantee that the run's actual topic gets
    // researched — not the raw working title, which is frequently a news headline that 404s
    // or, worse, fuzzy-resolves to an unrelated real page (a real run's title resolved to
    // "Brown dwarf" this way). Duplicates against the subject, and against each other, are
    // dropped before the entity cap is applied so a repeated name never displaces a distinct one.
    const seenQueries = new Set<string>([subject])
    const queries = [subject]
    for (const entity of entities) {
      if (queries.length >= MAX_ENTITIES_RESEARCHED) break
      if (seenQueries.has(entity)) continue
      seenQueries.add(entity)
      queries.push(entity)
    }
    ctx.log.info(`researching ${queries.length} entities: ${queries.join(', ')}`)

    const facts: ResearchFact[] = []
    const seen = new Set<string>()

    for (const query of queries) {
      try {
        const found = await ctx.providers.research.lookup(query, { maxFacts: MAX_FACTS_PER_ENTITY })
        for (const fact of found) {
          // Related articles repeat each other; a duplicated fact adds no grounding.
          const dedupeKey = fact.text.trim().toLowerCase()
          if (seen.has(dedupeKey)) continue
          seen.add(dedupeKey)
          facts.push(fact)
        }
      } catch (error) {
        // One unavailable article must not lose the facts already gathered.
        const detail = error instanceof Error ? error.message : String(error)
        ctx.log.warn(`research lookup for "${query}" failed and was skipped: ${detail}`)
      }
    }

    if (facts.length === 0) {
      return {
        status: 'halted',
        reason: `found no facts for any of ${queries.length} entities, so the script would be ungrounded`,
      }
    }

    // Zero facts is not the only ungrounded corpus. A real run gathered 13 facts — several of
    // them noise from an unrelated entity — for a ~22-beat script and the fact-checker rejected
    // the result outright (53% of claims unsupported). Judge the corpus against the same beat
    // plan the script writer is about to target, not a fixed magic number, so the floor scales
    // with duration/format the same way the script does.
    const { totalBeats } = computeBeatPlan(ctx.config)
    const minFacts = Math.ceil(totalBeats * ctx.config.llm.researchMinFactsPerBeat)
    if (facts.length < minFacts) {
      return {
        status: 'halted',
        reason:
          `gathered only ${facts.length} grounding facts from ${queries.length} entities, short of the ` +
          `${minFacts}-fact floor for a ~${totalBeats}-beat script (${ctx.config.llm.researchMinFactsPerBeat} ` +
          `facts/beat) — the script would not be reliably grounded`,
      }
    }

    await ctx.artifacts.write('research', ResearchSchema, {
      topicTitle: topic.title,
      facts,
    })

    ctx.log.info(`gathered ${facts.length} grounding facts from ${queries.length} entities`)
    return { status: 'done' }
  },
})
