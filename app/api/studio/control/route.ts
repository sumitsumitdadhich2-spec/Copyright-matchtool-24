import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { getSession } from '@/lib/users'
import {
  studioController,
  type StudioTestClipLine,
} from '@/lib/studio-automation'
import { prepareStudioMovie360pAndDrive } from '@/lib/media'
import { getScan } from '@/lib/store'
import { loadStudioUserConfig, saveUserGoogleCookies } from '@/lib/studio-settings'
import {
  buildStudioScanPlan,
  splitMovieBlockInHalf,
  type StudioScanJobPlan,
} from '@/lib/studio-window-planner'
import { fmtTime } from '@/lib/format'
import type { ChunkMatch, Scan, ShortSegmentState } from '@/lib/types'

interface ExpectedMatchEntry {
  short: string
  movie: string
  speed?: number
  note?: string
}

interface ExpectedNotFoundEntry {
  short: string
  note?: string
}

interface TestExpectedJson {
  short_duration_sec: number
  movie_duration_sec: number
  tolerance_sec: number
  matches: ExpectedMatchEntry[]
  not_found?: ExpectedNotFoundEntry[]
}

function parseTimeClock(raw: string): number {
  const parts = raw
    .trim()
    .split(':')
    .map((p) => Number(p.trim()))
  if (parts.some((n) => !Number.isFinite(n))) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] || 0
}

function parseRangePair(rangeStr: string): { start: number; end: number } {
  const [left, right] = rangeStr.split('-').map((s) => s.trim())
  return {
    start: parseTimeClock(left || '0'),
    end: parseTimeClock(right || '0'),
  }
}

/**
 * Merge contiguous 1x match pieces (e.g. when a model splits a match at an internal scene cut)
 * while also keeping original pieces so comparison can match either single or stitched pieces.
 */
function buildComparisonPool(matches: ChunkMatch[], toleranceSec: number): ChunkMatch[] {
  const sorted = [...matches].sort((a, b) => a.shortStart - b.shortStart || a.movieStart - b.movieStart)
  const stitched: ChunkMatch[] = []
  for (const m of sorted) {
    const prev = stitched[stitched.length - 1]
    if (
      prev &&
      Math.abs(m.shortStart - prev.shortEnd) <= toleranceSec * 2 &&
      Math.abs(m.movieStart - prev.movieEnd) <= toleranceSec * 2
    ) {
      prev.shortEnd = m.shortEnd
      prev.movieEnd = m.movieEnd
    } else {
      stitched.push({ ...m })
    }
  }
  return [...stitched, ...sorted]
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
        const testDataDir = path.join(process.cwd(), 'test-data')
        const moviePath = path.join(testDataDir, 'TEST_movie_360p.mp4')
        const shortPath = path.join(testDataDir, 'TEST_short.mp4')
        const expectedPath = path.join(testDataDir, 'TEST_expected.json')

        if (!fs.existsSync(moviePath) || !fs.existsSync(shortPath) || !fs.existsSync(expectedPath)) {
          return NextResponse.json(
            {
              ok: false,
              error: 'Missing test-data files (TEST_movie_360p.mp4, TEST_short.mp4, TEST_expected.json)',
            },
            { status: 400 },
          )
        }

        const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8')) as TestExpectedJson
        const shortDur = expected.short_duration_sec || 55
        const movieDur = expected.movie_duration_sec || 420
        const tolerance = expected.tolerance_sec ?? 0.15
        const chunkCount = Math.ceil(movieDur / 60)

        const cfg = await loadStudioUserConfig(username)

        // Build virtual scan + segment so the normal window planner splits 0-420s into 5-min windows
        const testSegments: ShortSegmentState[] = [
          {
            index: 0,
            start: 0,
            end: shortDur,
            status: 'pending',
            selected: true,
            chunks: Array.from({ length: chunkCount }, (_, i) => ({
              index: i,
              status: 'pending' as const,
              attempts: 0,
            })),
          },
        ]

        const virtualScan: Scan = {
          id: 'test-clip',
          createdAt: Date.now(),
          status: 'scanning',
          shortName: 'TEST_short.mp4',
          movieName: 'TEST_movie_360p.mp4',
          shortSize: null,
          movieSize: null,
          shortDuration: shortDur,
          movieDuration: movieDur,
          chunkCount,
          chunkingProgress: 100,
          chunks: testSegments[0].chunks,
          shortSegments: testSegments,
          matches: [],
          logs: [],
          startedAt: Date.now(),
          finishedAt: null,
          error: null,
          report: null,
          modelStates: {},
        }

        const plannedJobs: StudioScanJobPlan[] = buildStudioScanPlan(virtualScan, testSegments, {
          windowMinutes: cfg.studioWindowMinutes || 5,
          shortPartMinutes: cfg.studioShortPartMinutes || 3,
          windowOverlapSec: cfg.studioWindowOverlapSec || 0,
        })

        studioController.clearStop({ scanId: 'test-clip', username })
        studioController.setTestClipResult({
          status: 'running',
          summary: `Running ${plannedJobs.length} planned window(s) for TEST_short.mp4 (0–${shortDur}s) × TEST_movie_360p.mp4 (0–${movieDur}s)...`,
          lines: [],
          startedAt: Date.now(),
        })

        void (async () => {
          const release = await studioController.acquireJobLock('test-clip', username)
          try {
            const queue: StudioScanJobPlan[] = [...plannedJobs]
            const collectedMatches: ChunkMatch[] = []
            let completed = 0

            while (queue.length > 0 && !studioController.isStopping({ scanId: 'test-clip', username })) {
              const wJob = queue.shift()!
              const { shortPart, movieBlock } = wJob
              const shrinkLevel = wJob.shrinkLevel ?? 0
              const jobLabel = `Test Clip Window ${completed + 1}/${completed + queue.length + 1}: ${shortPart.label} × ${movieBlock.label}`

              const res = await studioController.runWindowJob({
                username,
                scanId: 'test-clip',
                jobLabel,
                modelName: cfg.studioModelName || 'Gemini 3.8 Flash',
                maxOutputTokens: cfg.studioMaxOutputTokens || 65536,
                maxInputTokens: cfg.studioMaxInputTokens,
                pageRecycleInterval: cfg.studioPageRecycleInterval,
                shortLocalPath: shortPath,
                shortStartSec: shortPart.startSec,
                shortEndSec: shortPart.endSec,
                movieLocalPath: moviePath,
                movieStartSec: movieBlock.startSec,
                movieEndSec: movieBlock.endSec,
              })

              if (res.status === 'shrink_needed') {
                const subBlocks =
                  shrinkLevel < 3
                    ? splitMovieBlockInHalf(virtualScan, movieBlock, cfg.studioWindowOverlapSec || 0)
                    : []
                if (subBlocks.length > 1) {
                  queue.unshift(
                    ...subBlocks.map((b, idx) => ({
                      jobIndex: wJob.jobIndex + idx,
                      shortPart,
                      movieBlock: b,
                      shrinkLevel: shrinkLevel + 1,
                    })),
                  )
                  continue
                }
                throw new Error(
                  `token counter too high (${res.tokenCount}) and block cannot be split`,
                )
              }

              if (res.status === 'success') {
                completed++
                collectedMatches.push(...res.matches)
              }
            }

            // Compare collected matches with TEST_expected.json (tolerance 0.15 s) and log PASS/FAIL per line
            const pool = buildComparisonPool(collectedMatches, tolerance)
            const resultLines: StudioTestClipLine[] = []

            for (const exp of expected.matches || []) {
              const sRange = parseRangePair(exp.short)
              const mRange = parseRangePair(exp.movie)
              const expectedLabel = `${exp.short} --> ${exp.movie}`

              const matched = pool.find(
                (cand) =>
                  Math.abs(cand.shortStart - sRange.start) <= tolerance &&
                  Math.abs(cand.shortEnd - sRange.end) <= tolerance &&
                  Math.abs(cand.movieStart - mRange.start) <= tolerance &&
                  Math.abs(cand.movieEnd - mRange.end) <= tolerance,
              )

              const closest =
                matched ||
                pool.find(
                  (cand) => cand.shortStart < sRange.end && cand.shortEnd > sRange.start,
                )

              const actualStr = closest
                ? `${fmtTime(closest.shortStart)} - ${fmtTime(closest.shortEnd)} --> ${fmtTime(closest.movieStart)} - ${fmtTime(closest.movieEnd)}`
                : 'NOT FOUND'
              const pass = Boolean(matched)
              const lineLog = `${pass ? 'PASS' : 'FAIL'} | Expected: ${expectedLabel} | Actual: ${actualStr}${exp.note ? ` (${exp.note})` : ''}`
              console.log(`[Studio Test Clip] ${lineLog}`)
              studioController.logStep(pass ? 'TEST PASS' : 'TEST FAIL', lineLog, pass ? 'success' : 'error')

              resultLines.push({
                label: exp.short,
                pass,
                expected: expectedLabel,
                actual: actualStr,
                detail: exp.note,
              })
            }

            for (const nf of expected.not_found || []) {
              const sRange = parseRangePair(nf.short)
              const expectedLabel = `${nf.short} --> NOT FOUND`
              const overlapping = collectedMatches.find(
                (cand) =>
                  Math.min(cand.shortEnd, sRange.end) - Math.max(cand.shortStart, sRange.start) >
                  tolerance,
              )
              const pass = !overlapping
              const actualStr = overlapping
                ? `${fmtTime(overlapping.shortStart)} - ${fmtTime(overlapping.shortEnd)} --> ${fmtTime(overlapping.movieStart)} - ${fmtTime(overlapping.movieEnd)}`
                : 'NOT FOUND'
              const lineLog = `${pass ? 'PASS' : 'FAIL'} | Expected: ${expectedLabel} | Actual: ${actualStr}${nf.note ? ` (${nf.note})` : ''}`
              console.log(`[Studio Test Clip] ${lineLog}`)
              studioController.logStep(pass ? 'TEST PASS' : 'TEST FAIL', lineLog, pass ? 'success' : 'error')

              resultLines.push({
                label: nf.short,
                pass,
                expected: expectedLabel,
                actual: actualStr,
                detail: nf.note,
              })
            }

            const passedCount = resultLines.filter((l) => l.pass).length
            const allPass = resultLines.length > 0 && passedCount === resultLines.length
            const summary = `${allPass ? 'PASS' : 'FAIL'} (${passedCount}/${resultLines.length} lines within ±${tolerance}s tolerance)`
            studioController.setTestClipResult({
              status: allPass ? 'pass' : 'fail',
              summary,
              lines: resultLines,
              startedAt: studioController.getTestClipResult()?.startedAt || Date.now(),
              finishedAt: Date.now(),
            })
            studioController.logStep(
              allPass ? 'test clip PASS' : 'test clip FAIL',
              summary,
              allPass ? 'success' : 'error',
            )
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            const isUserStopped =
              msg === 'STOPPED BY USER' ||
              /stopped by user/i.test(msg) ||
              studioController.isStopping({ scanId: 'test-clip', username })

            if (isUserStopped) {
              console.log('[Studio Test Clip] STOPPED BY USER')
              studioController.logStep('test clip STOPPED', 'STOPPED BY USER', 'warn')
              studioController.setTestClipResult({
                status: 'stopped',
                summary: 'STOPPED BY USER',
                lines: [],
                startedAt: studioController.getTestClipResult()?.startedAt || Date.now(),
                finishedAt: Date.now(),
              })
              return
            }

            console.error('[Studio Test Clip] ERROR:', msg)
            studioController.logStep('test clip ERROR', msg, 'error')
            studioController.setTestClipResult({
              status: 'error',
              summary: `ERROR: ${msg}`,
              lines: [],
              startedAt: studioController.getTestClipResult()?.startedAt || Date.now(),
              finishedAt: Date.now(),
            })
          } finally {
            studioController.setJobContext(null, null, null)
            release()
          }
        })()

        return NextResponse.json({
          ok: true,
          started: true,
          plannedWindows: plannedJobs.length,
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
