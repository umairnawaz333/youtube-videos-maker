import type { Repositories } from '@yt/db'

export interface PublishResult {
  ok: boolean
  message: string
}

/**
 * SEAM — replace the body of this function once the Publisher stage/provider lands.
 *
 * A sibling task is building `Publisher` (spec section 4, stage 14) and its `PublishProvider`
 * adapter concurrently, so this dashboard deliberately does NOT implement any YouTube upload
 * logic. This is the one place to wire it in: resolve the run's finished `seo.json` /
 * `out/video.mp4` / `thumbnail/v*.png`, obtain a `PublishProvider` from the provider bundle,
 * call `.publish(...)`, then on success:
 *   - `repos.runs.recordVideoId(runId, videoId)`
 *   - `repos.runs.setStatus(runId, 'published')`
 * and return `{ ok: true, message: ... }`.
 *
 * Until then this returns an honest "not implemented" result rather than a silent no-op or a
 * fabricated success, so the Publish button in the UI shows the real state of the world.
 */
const performPublish = async (runId: string): Promise<PublishResult> => ({
  ok: false,
  message:
    `Publishing for run '${runId}' is not implemented yet. The Publisher stage and its ` +
    'PublishProvider adapter are being built separately — see apps/dashboard/src/server/' +
    'publish.ts (performPublish) for the seam to wire it into.',
})

/**
 * Guards the seam above with the one piece of real, permanent dashboard logic: a run can only
 * be published once it has actually finished the pipeline and is sitting at the human review
 * gate. This check stays exactly as it is after the seam above is wired up.
 */
export const publishRun = async (repos: Repositories, runId: string): Promise<PublishResult> => {
  const run = await repos.runs.get(runId)
  if (!run) {
    return { ok: false, message: `run '${runId}' was not found` }
  }
  if (run.status !== 'awaiting_review') {
    return {
      ok: false,
      message: `run '${runId}' is not ready to publish yet (status: ${run.status})`,
    }
  }
  return performPublish(runId)
}
