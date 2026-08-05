import Link from 'next/link'
import { getRepos } from '@/server/db'
import { buildRunProgress, describeRunStatus } from '@/server/progress'
import { readReviewAssets, readScript, readSeo } from '@/server/artifacts'
import { readPendingRunInfo } from '@/server/pending'
import { PublishButton } from './PublishButton'

export const dynamic = 'force-dynamic'

const stageBadge = (status: string): string => {
  if (status === 'halted') return 'badge badge-halted'
  if (status === 'running') return 'badge badge-running'
  if (status === 'done') return 'badge badge-done'
  return 'badge badge-pending'
}

/** Full page reload every few seconds while the run is still moving, so progress and the
 * eventual review artifacts show up without any client-side polling code. */
function AutoRefresh({ status }: { status: string }) {
  const active = status === 'queued' || status === 'running' || status === 'awaiting_clips'
  if (!active) return null
  return <meta httpEquiv="refresh" content="5" />
}

export default async function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params
  const repos = getRepos()
  const run = await repos.runs.get(runId)

  if (!run) {
    const pending = await readPendingRunInfo(runId)
    return (
      <div className="stack">
        <p>
          <Link href="/">&larr; Runs</Link>
        </p>
        <h1>{runId}</h1>
        {!pending.found ? (
          <p className="empty">No such run.</p>
        ) : pending.failedToStart ? (
          <div className="halt-banner">
            <h3>The pipeline process never started</h3>
            <p>Check that `pnpm` is on PATH for the dashboard process.</p>
          </div>
        ) : pending.exitCode !== null && pending.exitCode !== 0 ? (
          <div className="halt-banner">
            <h3>The pipeline exited before creating a run record (code {pending.exitCode})</h3>
            <p>This usually means the model server health check failed. Log tail:</p>
            <pre>{pending.logTail ?? '(no output captured)'}</pre>
          </div>
        ) : (
          <div className="panel">
            <p className="muted">Starting… this page refreshes automatically.</p>
            <meta httpEquiv="refresh" content="3" />
          </div>
        )}
      </div>
    )
  }

  const [stageRecords, script, seo, assets] = await Promise.all([
    repos.runs.stages(runId),
    readScript(runId),
    readSeo(runId),
    readReviewAssets(runId),
  ])

  const progress = buildRunProgress(stageRecords)
  const readyToPublish = run.status === 'awaiting_review'

  return (
    <div className="stack">
      <AutoRefresh status={run.status} />
      <p>
        <Link href="/">&larr; Runs</Link>
      </p>

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>{run.id}</h1>
          <p className="muted">
            {run.niche} · {run.format} · created {run.createdAt.toLocaleString()}
          </p>
        </div>
        <span className={stageBadge(run.status === 'failed' ? 'halted' : run.status === 'published' ? 'done' : run.status === 'running' ? 'running' : 'pending')}>
          {describeRunStatus(run.status)}
        </span>
      </div>

      {progress.haltedStage && (
        <div className="halt-banner">
          <h3>Halted at &quot;{progress.haltedStage.name}&quot;</h3>
          <pre>{progress.haltedStage.reason}</pre>
        </div>
      )}

      <h2>Progress</h2>
      <ul className="stage-list">
        {progress.stages.map((stage) => (
          <li key={stage.name} className={`stage-item ${stage.status === 'halted' ? 'halted' : ''}`}>
            <span className={stageBadge(stage.status)}>{stage.status}</span>
            <span className="stage-name">{stage.name}</span>
            {stage.attempts > 1 && <span className="muted">attempt {stage.attempts}</span>}
          </li>
        ))}
      </ul>

      <h2>Video</h2>
      {assets.videoPath ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video controls src={`/media/${runId}/out/video.mp4`} />
      ) : (
        <p className="empty">Not rendered yet.</p>
      )}

      <h2>Thumbnail candidates</h2>
      {assets.thumbnailPaths.length > 0 ? (
        <div className="thumb-grid">
          {assets.thumbnailPaths.map((_, i) => (
            <figure key={i}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="review-thumb" src={`/media/${runId}/thumbnail/v${i + 1}.png`} alt={`Thumbnail candidate ${i + 1}`} />
              <figcaption>v{i + 1}</figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <p className="empty">Not generated yet.</p>
      )}

      <h2>SEO titles</h2>
      {seo ? (
        <div className="stack">
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Curiosity</th>
                <th>Search intent</th>
                <th>Simplicity</th>
                <th>CTR</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {[...seo.titles]
                .sort((a, b) => b.total - a.total)
                .map((t) => (
                  <tr key={t.title} className={t.title === seo.chosenTitle ? 'title-winner' : ''}>
                    <td>
                      {t.title} {t.title === seo.chosenTitle && <strong>(winner)</strong>}
                    </td>
                    <td>{t.scores.curiosity}</td>
                    <td>{t.scores.searchIntent}</td>
                    <td>{t.scores.simplicity}</td>
                    <td>{t.scores.ctr}</td>
                    <td>{t.total}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          <div className="panel">
            <p>
              <strong>Description</strong>
            </p>
            <p>{seo.description}</p>
            <p className="muted">Tags: {seo.tags.join(', ')}</p>
            <p className="muted">Hashtags: {seo.hashtags.join(' ')}</p>
          </div>
        </div>
      ) : (
        <p className="empty">Not generated yet.</p>
      )}

      <h2>Script</h2>
      {script ? (
        <div className="stack">
          {script.sections.map((section) => (
            <div className="script-section" key={section.kind}>
              <h4>{section.kind}</h4>
              {section.beats.map((beat) => (
                <div className="beat" key={beat.id}>
                  <p>{beat.text}</p>
                  <p className="meta">
                    {beat.id} · ~{beat.targetSeconds}s
                  </p>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <p className="empty">Not generated yet.</p>
      )}

      <h2>Publish</h2>
      <PublishButton runId={runId} ready={readyToPublish} />
    </div>
  )
}
