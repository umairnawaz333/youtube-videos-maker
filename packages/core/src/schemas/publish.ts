import { z } from 'zod'

/**
 * NOT re-exported from `./index.ts` yet — that barrel file is owned by the pipeline
 * integrator in this plan. Importers reach this module directly via the existing
 * `@yt/core/*` path mapping (tsconfig.base.json and vitest.config.ts's alias both already
 * resolve subpaths, e.g. `import { PublishDecisionSchema } from '@yt/core/schemas/publish'`),
 * which needs no change to the forbidden barrel. See the Publisher plan report for the single
 * line (`export * from './schemas/publish'`) that would fold this into the normal `@yt/core`
 * surface once someone who owns `index.ts` wants to.
 */

/** The three privacy statuses the YouTube Data API v3 accepts on a video resource. */
export const PUBLISH_PRIVACIES = ['private', 'unlisted', 'public'] as const
export type PublishPrivacy = (typeof PUBLISH_PRIVACIES)[number]
export const PublishPrivacySchema = z.enum(PUBLISH_PRIVACIES)

/**
 * The human's decision at the "review click" the spec describes (section 9's Publish button):
 * written to `<run>/publish-decision.json` by whatever calls Publish (the dashboard, or —
 * until that exists — a hand-written file, or a future CLI flag). Its presence is the gate
 * from spec section 14 ("Runs only after the human review click, unless auto-publish is
 * explicitly enabled"): the Publisher stage refuses to upload without either this file or
 * `config.autoPublish`.
 *
 * Every field but `approved`/`approvedAt` is optional because the dashboard's run-detail view
 * (section 9) pre-fills a winning title, a chosen thumbnail, and editable description/tags —
 * a plain click-Publish with no edits should still work, falling back to what `seo.json` and
 * the thumbnailer already produced.
 */
export const PublishDecisionSchema = z.object({
  approved: z.literal(true),
  approvedAt: z.string().min(1),
  privacy: PublishPrivacySchema.optional(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /** File name only (e.g. "v2.png"), resolved against `ctx.paths.thumbnail`. */
  thumbnail: z.string().min(1).optional(),
})
export type PublishDecision = z.infer<typeof PublishDecisionSchema>

/**
 * What the Publisher stage records to `<run>/publish-result.json` once an upload completes.
 *
 * This exists because neither `StageOutcome` (packages/core/src/stage.ts) nor `RunContext`
 * gives a stage a channel back to the `Run.videoId` database column, and both files are outside
 * this plan's boundary. A file under the run's own directory is the same pattern the rest of
 * the pipeline already uses to hand data to "whatever looks at this run next" (see
 * `seo.json`, `videoSpec.json`): the integrator's job is a small read-this-file-and-call-
 * `repos.runs.recordVideoId` step, not a new persistence mechanism.
 */
export const PublishResultSchema = z.object({
  videoId: z.string().min(1),
  publishedAt: z.string().min(1),
  requestedPrivacy: PublishPrivacySchema,
  /**
   * A static advisory, not a verified fact: this stage has no way to learn what privacy
   * YouTube actually applied (`PublishProvider.publish()` returns only `{ videoId }` — see
   * `packages/core/src/providers.ts`, which this plan must not redesign). While the OAuth
   * app is in Testing mode, YouTube silently forces every upload to private regardless of
   * `requestedPrivacy`; the concrete `YoutubePublishProvider` DOES see the real API response
   * and logs a runtime warning when it detects that mismatch (packages/providers/src/publish),
   * but that detection cannot reach this file without widening `PublishProvider`'s return
   * type. Surfaced here anyway so a reader of this file — not just of process logs — is told
   * to go check YouTube Studio rather than trusting `requestedPrivacy` blindly.
   */
  testingModeCaveat: z.string(),
})
export type PublishResult = z.infer<typeof PublishResultSchema>
