import type { Stage } from '@yt/core'
import { createFactCheckerStage } from './fact-checker'
import { createResearcherStage } from './researcher'
import { createScenePlannerStage } from './scene-planner'
import { createScriptWriterStage } from './script-writer'
import { createSeoStage } from './seo'
import { createTopicScoutStage } from './topic-scout'

/**
 * The six LLM-resident stages, in canonical order. StageRunner validates that a stage list is
 * a leading prefix of STAGE_NAMES, so this is directly runnable as a partial pipeline until
 * later plans add the media and render stages.
 */
export const buildLlmStages = (): Stage[] => [
  createTopicScoutStage(),
  createResearcherStage(),
  createScriptWriterStage(),
  createFactCheckerStage(),
  createScenePlannerStage(),
  createSeoStage(),
]
