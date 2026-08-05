'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { getRepos } from '@/server/db'
import { publishRun, type PublishResult } from '@/server/publish'
import { triggerRun } from '@/server/trigger-run'

/** The Generate button. Triggers a run (see server/trigger-run.ts) and jumps to its page. */
export async function generateAction(): Promise<void> {
  const { runId } = await triggerRun()
  redirect(`/runs/${runId}`)
}

/** The Publish button. See server/publish.ts for the seam this calls into. */
export async function publishAction(runId: string): Promise<PublishResult> {
  const result = await publishRun(getRepos(), runId)
  revalidatePath(`/runs/${runId}`)
  return result
}
