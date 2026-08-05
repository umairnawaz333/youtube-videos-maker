export const STAGE_NAMES = [
  'topic-scout',
  'researcher',
  'script-writer',
  'fact-checker',
  'scene-planner',
  'seo',
  'illustrator',
  'thumbnailer',
  'narrator',
  'captioner',
  'clip-gate',
  'editor',
  'quality-gate',
  'publisher',
] as const

export type StageName = (typeof STAGE_NAMES)[number]

/**
 * 'exclusive' means "evict whatever is resident before me — I need the memory to
 * myself". It is how the render and narration block force the image model out; without
 * it an 8 GB image model would still be resident when a headless browser starts.
 */
export type ModelRequirement = 'llm' | 'sd' | 'none' | 'exclusive'

/**
 * Grouped so the ModelBroker performs two evictions per run rather than twelve.
 * See spec section 2. Do not reorder.
 */
export const STAGE_REQUIREMENTS: Record<StageName, ModelRequirement> = {
  'topic-scout': 'llm',
  researcher: 'llm',
  'script-writer': 'llm',
  'fact-checker': 'llm',
  'scene-planner': 'llm',
  seo: 'llm',
  illustrator: 'sd',
  thumbnailer: 'sd',
  narrator: 'exclusive',
  captioner: 'none',
  'clip-gate': 'none',
  editor: 'exclusive',
  'quality-gate': 'none',
  publisher: 'none',
}

export const STAGE_RETRY_KIND: Record<StageName, 'llm' | 'network' | 'render' | 'local'> = {
  'topic-scout': 'network',
  researcher: 'network',
  'script-writer': 'llm',
  'fact-checker': 'llm',
  'scene-planner': 'llm',
  seo: 'llm',
  illustrator: 'local',
  thumbnailer: 'local',
  narrator: 'local',
  captioner: 'local',
  'clip-gate': 'local',
  editor: 'render',
  'quality-gate': 'local',
  publisher: 'network',
}

export const RUN_STATUSES = [
  'queued',
  'running',
  'awaiting_clips',
  'awaiting_review',
  'failed',
  'published',
] as const

export type RunStatus = (typeof RUN_STATUSES)[number]

export const SECTION_KINDS = [
  'hook',
  'question',
  'conflict',
  'curiosity',
  'reveal',
  'twist',
  'conclusion',
  'cta',
] as const

export type SectionKind = (typeof SECTION_KINDS)[number]

export const CAMERA_MOVES = [
  'zoom-in',
  'zoom-out',
  'pan-left',
  'pan-right',
  'parallax',
  'still',
] as const

export type CameraMove = (typeof CAMERA_MOVES)[number]

export const VIDEO_FORMATS = ['shorts', 'long'] as const

export type VideoFormat = (typeof VIDEO_FORMATS)[number]
