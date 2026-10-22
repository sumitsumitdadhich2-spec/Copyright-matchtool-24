import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import { getScan, saveScan, addLog } from '@/lib/store'
import { MEDIA_DIR } from '@/lib/paths'
import { downloadYoutubeVideo, isValidYoutubeUrl } from '@/lib/yt-dlp'
import { finalizeUploadedMedia } from '@/lib/media'
import { getSession } from '@/lib/users'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const scan = getScan(id)
  if (!scan) {
    return NextResponse.json({ error: 'Scan not found' }, { status: 404 })
  }

  const user = await getSession()
  const owner = user?.username || scan.ownerUsername || 'admin'

  const body = (await req.json().catch(() => ({}))) as { url?: string }
  const url = (body.url || '').trim()
  if (!url || !isValidYoutubeUrl(url)) {
    return NextResponse.json(
      { error: 'Please provide a valid YouTube link (youtube.com/shorts/... or youtu.be/...)' },
      { status: 400 },
    )
  }

  const mediaDir = path.join(MEDIA_DIR, id)
  const destPath = path.join(mediaDir, 'short.mp4')

  scan.shortYoutubeUrl = url
  addLog(scan, 'info', `Downloading Short from YouTube via yt-dlp: ${url}`)
  saveScan(scan, { immediate: true })

  try {
    await downloadYoutubeVideo(url, destPath)
    const label = `YouTube Short (${url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 36)})`
    if (!scan.ownerUsername) scan.ownerUsername = owner
    const res = await finalizeUploadedMedia(scan, 'short', label)
    if (!res.ok) {
      return NextResponse.json({ error: res.error }, { status: 400 })
    }
    const updated = getScan(id) || scan
    updated.shortYoutubeUrl = url
    addLog(
      updated,
      'success',
      `YouTube Short downloaded and prepared (${updated.shortDuration?.toFixed(1) || '?'}s). In Gemini Studio mode, this YouTube URL will be attached directly!`,
    )
    saveScan(updated, { immediate: true })
    return NextResponse.json({ ok: true, scan: updated })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    addLog(scan, 'error', `YouTube Short download failed: ${msg}`)
    saveScan(scan, { immediate: true })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
