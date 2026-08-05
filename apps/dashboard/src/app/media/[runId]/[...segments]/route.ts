import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { NextRequest } from 'next/server'
import { resolveMediaPath } from '@/server/artifacts'

/**
 * Streams the two kinds of file the review page ever links to — the rendered MP4 and the
 * thumbnail candidates — straight off disk from `storage/videos/<runId>/...`, which sits
 * outside Next's `public/` folder and therefore needs a route handler rather than a static
 * asset. `resolveMediaPath` is the allowlist: this route can serve nothing else.
 *
 * Range requests are supported because Chrome/Safari issue them for `<video>` seeking; without
 * a 206 response, scrubbing the player silently fails.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.png': 'image/png',
}

const notFound = () => new Response('Not found', { status: 404 })

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string; segments: string[] }> },
) {
  const { runId, segments } = await params
  const filePath = resolveMediaPath(runId, segments)
  if (!filePath) return notFound()

  let size: number
  try {
    size = (await fsp.stat(filePath)).size
  } catch {
    return notFound()
  }

  const ext = filePath.slice(filePath.lastIndexOf('.'))
  const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream'
  const range = request.headers.get('range')

  if (!range) {
    const body = Readable.toWeb(fs.createReadStream(filePath)) as unknown as ReadableStream
    return new Response(body, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
      },
    })
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range)
  if (!match) return new Response('Invalid Range', { status: 416 })

  const [, startRaw, endRaw] = match
  const start = startRaw ? parseInt(startRaw, 10) : 0
  const end = endRaw ? parseInt(endRaw, 10) : size - 1
  const chunkSize = end - start + 1

  const body = Readable.toWeb(fs.createReadStream(filePath, { start, end })) as unknown as ReadableStream
  return new Response(body, {
    status: 206,
    headers: {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(chunkSize),
    },
  })
}
