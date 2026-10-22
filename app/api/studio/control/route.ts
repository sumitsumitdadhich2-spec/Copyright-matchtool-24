import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getSession } from '@/lib/users'
import { studioController } from '@/lib/studio-automation'
import { prepareStudioMovie360pAndDrive } from '@/lib/media'
import { getScan } from '@/lib/store'
import { loadStudioUserConfig, saveUserGoogleCookies } from '@/lib/studio-settings'
import { getFfmpegPathSync } from '@/lib/ffmpeg-bin'
import { CHUNK_MAP_PROMPT, parseChunkMatches } from '@/lib/gemini'

const execFileAsync = promisify(execFile)

async function ensureSyntheticTestVideos(): Promise<{ moviePath: string; shortPath: string }> {
  const ffmpegBin = getFfmpegPathSync()
  const moviePath = '/tmp/cmt_studio_test_movie_360p.mp4'
  const shortPath = '/tmp/cmt_studio_test_short.mp4'
  if (!fs.existsSync(moviePath) || fs.statSync(moviePath).size < 10_000) {
    await execFileAsync(ffmpegBin, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=24:duration=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=30',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-r',
      '24',
      '-c:a',
      'aac',
      '-ac',
      '1',
      '-b:a',
      '48k',
      moviePath,
    ])
  }
  if (!fs.existsSync(shortPath) || fs.statSync(shortPath).size < 5_000) {
    await execFileAsync(ffmpegBin, [
      '-y',
      '-ss',
      '10',
      '-t',
      '10',
      '-i',
      moviePath,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-r',
      '24',
      '-c:a',
      'aac',
      '-ac',
      '1',
      '-b:a',
      '48k',
      shortPath,
    ])
  }
  return { moviePath, shortPath }
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 })
  }
  if (!studioController.canUserAccessStudio(session)) {
    return NextResponse.json(
      { ok: false, error: 'Forbidden: Studio browser is currently loaded for another user' },
      { status: 403 },
    )
  }
  const username = session.username

  const body = (await req.json().catch(() => ({}))) as {
    action?: string
    xRatio?: number
    yRatio?: number
    text?: string
    key?: string
    url?: string
    enabled?: boolean
    scanId?: string
    cookiesJson?: string
  }

  try {
    switch (body.action) {
      case 'save_cookies': {
        if (!body.cookiesJson || !body.cookiesJson.trim()) {
          return NextResponse.json({ ok: false, error: 'Paste Cookie-Editor JSON first' }, { status: 400 })
        }
        const saved = await saveUserGoogleCookies(username, body.cookiesJson)
        return NextResponse.json({
          ok: true,
          cookieCount: saved.count,
          snapshot: await studioController.getSnapshot(false),
        })
      }
      case 'run_test_window': {
        const cfg = await loadStudioUserConfig(username)
        const { moviePath, shortPath } = await ensureSyntheticTestVideos()
        void (async () => {
          const release = await studioController.acquireJobLock('test-scan', username)
          try {
            const res = await studioController.runWindowJob({
              username,
              scanId: 'test-scan',
              jobLabel: '1-Video Studio Chunk Test (10s Short + 30s Movie @ 24fps)',
              modelName: cfg.studioModelName || 'Gemini 2.5 Pro',
              maxOutputTokens: cfg.studioMaxOutputTokens || 65536,
              shortSource: {
                kind: 'local',
                filePath: shortPath,
                startSec: 0,
                endSec: 10,
              },
              movieSource: {
                filePath: moviePath,
                startSec: 0,
                endSec: 30,
              },
              promptText: CHUNK_MAP_PROMPT,
              maxTokensPerRequest: 900_000,
              offsetMode: cfg.studioOffsetMode || 'auto',
            })
            if (res.status === 'ok') {
              const matches = parseChunkMatches(res.rawText, 0, 0, 10, 30)
              console.log(
                `[Studio 1-Video Test] SUCCESS: status=ok, tokens=${res.tokenCount}, matches=${matches.length}, raw=${JSON.stringify(res.rawText.slice(0, 300))}`,
              )
            } else {
              console.warn(`[Studio 1-Video Test] ENDED: status=${res.status}, error=${res.error}`)
            }
          } catch (err) {
            console.error('[Studio 1-Video Test] ERROR:', err)
          } finally {
            release()
          }
        })()
        return NextResponse.json({
          ok: true,
          started: true,
          snapshot: await studioController.getSnapshot(true),
        })
      }
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
        studioController.requestStop({
          scanId: body.scanId,
          username: session.role === 'admin' ? undefined : username,
        })
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
        const scan = getScan(body.scanId)
        if (!scan) {
          return NextResponse.json({ ok: false, error: 'Scan not found' }, { status: 404 })
        }
        if (session.role !== 'admin' && scan.ownerUsername && scan.ownerUsername !== username) {
          return NextResponse.json(
            { ok: false, error: 'Forbidden: scan belongs to another user' },
            { status: 403 },
          )
        }
        void prepareStudioMovie360pAndDrive(body.scanId, undefined, undefined, scan.ownerUsername || username)
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
