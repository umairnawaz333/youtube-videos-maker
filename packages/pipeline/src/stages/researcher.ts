import { z } from 'zod'
import {
  ResearchSchema,
  STAGE_REQUIREMENTS,
  TopicSchema,
  type ResearchFact,
  type Stage,
} from '@yt/core'
import { buildEntityPrompt } from './prompts/researcher'

const EntitiesSchema = z.object({
  entities: z.array(z.string().min(1)).min(1).max(8),
})

/** Facts per entity. Enough to ground a script without burning the context window. */
const MAX_FACTS_PER_ENTITY = 8

export const createResearcherStage = (): Stage => ({
  name: 'researcher',
  requires: STAGE_REQUIREMENTS.researcher,

  async run(ctx) {
    const topic = await ctx.artifacts.read('topic', TopicSchema)

    const { entities } = await ctx.providers.llm.json(
      buildEntityPrompt({ title: topic.title, angle: topic.angle }),
      'ResearchEntities',
      (raw) => EntitiesSchema.parse(raw),
    )

    // The subject itself is not optional, whatever the model returned.
    const queries = [topic.title, ...entities.filter((e) => e !== topic.title)]
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

    await ctx.artifacts.write('research', ResearchSchema, {
      topicTitle: topic.title,
      facts,
    })

    ctx.log.info(`gathered ${facts.length} grounding facts from ${queries.length} entities`)
    return { status: 'done' }
  },
})
