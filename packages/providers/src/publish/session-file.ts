import fs from 'node:fs/promises'

/**
 * A resumable YouTube upload session URI is single-use and lives ~24h. Persisting it next to
 * the video file (rather than only in memory) is what makes the upload survive the *process*
 * being interrupted, not just a single flaky request: on restart, the provider finds this file,
 * skips `videos.insert` (which would otherwise mint a second, duplicate video), and asks the
 * existing session how many bytes it already has before resuming the PUT loop.
 */
export interface UploadSession {
  uploadUrl: string
  totalBytes: number
  contentType: string
}

export const sessionFilePathFor = (videoPath: string): string => `${videoPath}.upload-session.json`

export const readUploadSession = async (videoPath: string): Promise<UploadSession | null> => {
  try {
    const raw = await fs.readFile(sessionFilePathFor(videoPath), 'utf8')
    return JSON.parse(raw) as UploadSession
  } catch {
    return null
  }
}

export const writeUploadSession = async (videoPath: string, session: UploadSession): Promise<void> => {
  await fs.writeFile(sessionFilePathFor(videoPath), JSON.stringify(session), 'utf8')
}

export const clearUploadSession = async (videoPath: string): Promise<void> => {
  try {
    await fs.unlink(sessionFilePathFor(videoPath))
  } catch {
    // Nothing to clear — fine either way (never written, or already cleared).
  }
}
