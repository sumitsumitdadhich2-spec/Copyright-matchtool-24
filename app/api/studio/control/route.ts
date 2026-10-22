import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/users'
import { studioController } from '@/lib/studio-automation'
import { prepareStudioMovie360pAndDrive } from '@/lib/media'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const user = await getSession()
  const username = user?.username || 'admin'

  const body = (await req.json().catch(() => ({}))) as {
    action?: string
    xRatio?: number
    yRatio?: number
    text?: string
    key?: string
    url?: string
    enabled?: boolean
    scanId?: string
  }

  try {
    switch (body.action) {
      case 'test_login': {
        const res = await studioController.testLogin(username)
        const snap = await studioController.getSnapshot(true)
        return NextResponse.json({ ok: true, ...res, snapshot: snap })
      }
      case 'pause': {
        studioController.setPaused(true)
        return NextResponse.json({ ok: true, snapshot: await studioController.getSnapshot(false) })
      }
      case 'resume': {
        studioController.setPaused(false)
        return NextResponse.json({ ok: true, snapshot: await studioController.getSnapshot(false) })
      }
      case 'stop': {
        studioController.requestStop()
        return NextResponse.json({ ok: true, snapshot: await studioController.getSnapshot(false) })
      }
      case 'assist_toggle': {
        const nextVal = Boolean(body.enabled)
        studioController.setAssistMode(nextVal)
        if (nextVal) {
          await studioController.ensurePage(username)
        }
        return NextResponse.json({ ok: true, snapshot: await studioController.getSnapshot(true) })
      }
      case 'click': {
        const snap = await studioController.performAssistAction(username, {
          type: 'click',
          xRatio: Number(body.xRatio) || 0,
          yRatio: Number(body.yRatio) || 0,
        })
        return NextResponse.json({ ok: true, snapshot: snap })
      }
      case 'type': {
        const snap = await studioController.performAssistAction(username, {
          type: 'type',
          text: String(body.text || ''),
        })
        return NextResponse.json({ ok: true, snapshot: snap })
      }
      case 'key': {
        const snap = await studioController.performAssistAction(username, {
          type: 'key',
          key: String(body.key || 'Enter'),
        })
        return NextResponse.json({ ok: true, snapshot: snap })
      }
      case 'navigate': {
        const snap = await studioController.performAssistAction(username, {
          type: 'navigate',
          url: String(body.url || 'https://aistudio.google.com/prompts/new_chat'),
        })
        return NextResponse.json({ ok: true, snapshot: snap })
      }
      case 'save_session': {
        const snap = await studioController.performAssistAction(username, {
          type: 'save_session',
        })
        return NextResponse.json({ ok: true, snapshot: snap })
      }
      case 'prepare_movie': {
        if (!body.scanId) {
          return NextResponse.json({ ok: false, error: 'Missing scanId' }, { status: 400 })
        }
        void prepareStudioMovie360pAndDrive(body.scanId, undefined, undefined, username)
        return NextResponse.json({ ok: true })
      }
      default:
        return NextResponse.json({ ok: false, error: 'Unknown Studio action' }, { status: 400 })
    }
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
