import { z } from 'zod'

/**
 * A single transcribed word with its timestamps on the run's GLOBAL narration timeline —
 * i.e. already shifted past every earlier scene's measured duration, not relative to the
 * per-scene WAV file whisper actually transcribed. See the captioner stage for the shift.
 */
export const CaptionWordSchema = z
  .object({
    word: z.string().min(1),
    startSec: z.number().min(0),
    endSec: z.number().min(0),
  })
  .refine((w) => w.endSec >= w.startSec, {
    message: 'endSec must be >= startSec',
    path: ['endSec'],
  })
export type CaptionWordEntry = z.infer<typeof CaptionWordSchema>

/** The on-disk shape of captions/words.json. */
export const CaptionWordsFileSchema = z.object({
  words: z.array(CaptionWordSchema),
})
export type CaptionWordsFile = z.infer<typeof CaptionWordsFileSchema>
