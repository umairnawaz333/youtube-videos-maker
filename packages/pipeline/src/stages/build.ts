import type { Stage } from '@yt/core'
import { createCaptionerStage } from './captioner'
import { createClipGateStage } from './clip-gate'
import { createEditorStage } from './editor'
import { createFactCheckerStage } from './fact-checker'
import { createIllustratorStage } from './illustrator'
import { createNarratorStage } from './narrator'
import { createQualityGateStage } from './quality-gate'
import { createResearcherStage } from './researcher'
import { createScenePlannerStage } from './scene-planner'
import { createScriptWriterStage } from './script-writer'
import { createSeoStage } from './seo'
import { createThumbnailerStage } from './thumbnailer'
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

/**
 * The LLM block plus the image block and the small-model block: stages 1-10 of STAGE_NAMES.
 *
 * Still a leading prefix, which is what StageRunner requires — the render stages (clip-gate,
 * editor, quality-gate, publisher) are not built yet, so this is the longest runnable pipeline.
 * Ordering is not a free choice: it mirrors STAGE_NAMES so that all 'llm' work finishes before
 * any 'sd' work begins, which is what holds the broker to two model evictions per run instead
 * of a dozen (spec section 2).
 */
export const buildMediaStages = (): Stage[] => [
  ...buildLlmStages(),
  createIllustratorStage(),
  createThumbnailerStage(),
  createNarratorStage(),
  createCaptionerStage(),
]

/**
 * Stages 1-13: everything except the Publisher, which needs Google OAuth credentials the repo
 * cannot ship. This is the longest pipeline that runs without an external account, and it ends
 * where the design says it should — at a finished video awaiting a human review click.
 *
 * Still a leading prefix of STAGE_NAMES, which StageRunner enforces.
 */
export const buildFullStages = (): Stage[] => [
  ...buildMediaStages(),
  createClipGateStage(),
  createEditorStage(),
  createQualityGateStage(),
]
