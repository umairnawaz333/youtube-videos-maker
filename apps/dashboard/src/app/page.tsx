import Link from 'next/link'
import { generateAction } from './actions'
import { listRuns } from '@/server/db'
import { describeRunStatus } from '@/server/progress'

export const dynamic = 'force-dynamic'

const badgeClass = (status: string): string => {
  if (status === 'failed') return 'badge badge-halted'
  if (status === 'published') return 'badge badge-published'
  if (status === 'running') return 'badge badge-running'
  if (status === 'awaiting_review' || status === 'awaiting_clips') return 'badge badge-running'
  return 'badge badge-pending'
}

export default async function HomePage() {
  const runs = await listRuns()

  return (
    <div className="stack">
      <nav className="top">
        <h1>AI YouTube Factory</h1>
      </nav>

      <div className="panel">
        <form action={generateAction}>
          <div className="row">
            <button type="submit">Generate</button>
            <span className="muted">
              Starts a new run against `config/app.json`&apos;s current niche and format.
            </span>
          </div>
        </form>
      </div>

      <h2>Runs</h2>
      {runs.length === 0 ? (
        <p className="empty">No runs yet. Click Generate to start one.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Niche</th>
              <th>Format</th>
              <th>Status</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td>
                  <Link href={`/runs/${run.id}`}>{run.id}</Link>
                </td>
                <td>{run.niche}</td>
                <td>{run.format}</td>
                <td>
                  <span className={badgeClass(run.status)}>{describeRunStatus(run.status)}</span>
                </td>
                <td className="muted">{run.updatedAt.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
