'use client'

import { useState, useTransition } from 'react'
import { publishAction } from '../../actions'

/**
 * The human review gate's one action. Calls the seam in `server/publish.ts` and shows
 * whatever it reports — including its current "not implemented yet" message — rather than
 * hiding the button or faking success.
 */
export function PublishButton({ runId, ready }: { runId: string; ready: boolean }) {
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<string | null>(null)
  const [ok, setOk] = useState<boolean | null>(null)

  const onClick = () => {
    startTransition(async () => {
      const result = await publishAction(runId)
      setOk(result.ok)
      setMessage(result.message)
    })
  }

  return (
    <div className="stack">
      <div className="row">
        <button onClick={onClick} disabled={!ready || pending}>
          {pending ? 'Publishing…' : 'Publish'}
        </button>
        {!ready && <span className="muted">Available once the run reaches &quot;Awaiting review&quot;.</span>}
      </div>
      {message && (
        <p className={ok ? 'muted' : 'empty'} style={{ color: ok ? 'var(--ok)' : 'var(--warn)' }}>
          {message}
        </p>
      )}
    </div>
  )
}
