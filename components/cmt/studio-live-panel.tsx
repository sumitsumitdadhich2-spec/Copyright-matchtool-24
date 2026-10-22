'use client'

import { useState, useEffect, useRef } from 'react'
import {
  Monitor,
  Pause,
  Play,
  Square,
  MousePointerClick,
  Save,
  RefreshCw,
  Terminal,
  Send,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Scan } from '@/lib/types'
import { cn } from '@/lib/utils'

interface StudioStepLog {
  t: number
  step: string
  detail?: string
  level: 'info' | 'success' | 'warn' | 'error'
}

interface StudioLiveSnapshot {
  active: boolean
  paused: boolean
  assistMode: boolean
  currentStep: string
  currentUrl: string
  scanId: string | null
  jobLabel: string | null
  tokenCount: number | null
  elapsedSec: number
  screenshotBase64: string | null
  screenshotAt: number | null
  viewport: { width: number; height: number }
  logs: StudioStepLog[]
}

export function StudioLivePanel({ scan }: { scan: Scan | null }) {
  const [expanded, setExpanded] = useState(true)
  const [snap, setSnap] = useState<StudioLiveSnapshot | null>(null)
  const [streamConnected, setStreamConnected] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [assistText, setAssistText] = useState('')
  const [assistUrl, setAssistUrl] = useState('https://aistudio.google.com/prompts/new_chat')
  const [actionToast, setActionToast] = useState<string | null>(null)
  const [clickMarker, setClickMarker] = useState<{ xPct: number; yPct: number } | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)

  const isStudioScan = scan?.chunkScanEngine === 'studio'
  const isActiveOrAssist =
    isStudioScan || Boolean(snap?.active || snap?.paused || snap?.assistMode)

  useEffect(() => {
    if (!expanded) return

    let es: EventSource | null = null
    let fallbackTimer: ReturnType<typeof setInterval> | null = null
    let mounted = true

    const pollOnce = async () => {
      try {
        const res = await fetch('/api/studio/stream?once=1', { cache: 'no-store' })
        if (!res.ok || !mounted) return
        const data = (await res.json()) as StudioLiveSnapshot
        if (mounted) setSnap(data)
      } catch {}
    }

    try {
      es = new EventSource('/api/studio/stream')
      es.onopen = () => {
        if (mounted) setStreamConnected(true)
      }
      es.onmessage = (ev) => {
        if (!mounted) return
        try {
          const data = JSON.parse(ev.data) as StudioLiveSnapshot
          setSnap(data)
        } catch {}
      }
      es.onerror = () => {
        if (mounted) setStreamConnected(false)
      }
    } catch {
      void pollOnce()
      fallbackTimer = setInterval(pollOnce, 1500)
    }

    return () => {
      mounted = false
      if (es) es.close()
      if (fallbackTimer) clearInterval(fallbackTimer)
    }
  }, [expanded])

  const sendControl = async (payload: Record<string, unknown>, label?: string) => {
    if (label) setBusyAction(label)
    try {
      const res = await fetch('/api/studio/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (data.snapshot) {
        setSnap(data.snapshot as StudioLiveSnapshot)
      }
      if (!res.ok || data.ok === false) {
        setActionToast(data.error || 'Action failed')
      } else if (label === 'save_session') {
        setActionToast('Active browser session cookies encrypted & saved to server!')
      } else if (label === 'test_login') {
        setActionToast(
          data.loggedIn
            ? `Logged in to AI Studio${data.email ? ` (${data.email})` : ''}`
            : `Not logged in: ${data.detail || 'Open Login Assist or paste fresh cookies'}`,
        )
      }
    } catch (err) {
      setActionToast((err as Error).message)
    } finally {
      if (label) setBusyAction(null)
      setTimeout(() => setActionToast(null), 5000)
    }
  }

  const handleScreenshotClick = async (e: React.MouseEvent<HTMLImageElement>) => {
    if (!snap?.assistMode || !imgRef.current) return
    const rect = imgRef.current.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return

    const xRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const yRatio = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))

    setClickMarker({ xPct: xRatio * 100, yPct: yRatio * 100 })
    setTimeout(() => setClickMarker(null), 700)

    await sendControl({ action: 'click', xRatio, yRatio })
  }

  const formatElapsed = (sec: number) => {
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  const statusBadge = () => {
    if (snap?.assistMode) {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/15 px-2.5 py-0.5 text-[11px] font-medium text-sky-300 border border-sky-500/30">
          <MousePointerClick className="h-3 w-3" />
          Login Assist (Interactive)
        </span>
      )
    }
    if (snap?.paused) {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-medium text-amber-300 border border-amber-500/30">
          paused
        </span>
      )
    }
    if (snap?.active) {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-medium text-emerald-400 border border-emerald-500/30">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
          running {formatElapsed(snap?.elapsedSec || 0)}
        </span>
      )
    }
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground border border-border">
        idle
      </span>
    )
  }

  if (!isActiveOrAssist && !expanded) {
    return null
  }

  const screenshotSrc = snap?.screenshotBase64
    ? snap.screenshotBase64.startsWith('data:')
      ? snap.screenshotBase64
      : `data:image/jpeg;base64,${snap.screenshotBase64}`
    : null

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-secondary/30 px-4 py-2.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 text-left text-xs font-semibold uppercase tracking-wider text-foreground hover:text-primary transition-colors"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <Monitor className="h-3.5 w-3.5 text-emerald-400" />
          <span>Gemini Studio Live</span>
          {statusBadge()}
          {snap?.tokenCount != null && (
            <span className="rounded bg-secondary px-2 py-0.5 font-mono text-[10px] text-foreground">
              tokens {Math.round(snap.tokenCount / 1000)}K
            </span>
          )}
          {snap?.currentStep && snap.currentStep !== 'idle' && (
            <span className="rounded bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary truncate max-w-[260px]">
              {snap.currentStep}
            </span>
          )}
        </button>

        <div className="flex flex-wrap items-center gap-1.5">
          {snap?.active && !snap?.paused && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => sendControl({ action: 'pause' }, 'pause')}
              disabled={busyAction !== null}
              className="h-7 px-2.5 text-[11px] gap-1"
            >
              <Pause className="h-3 w-3" />
              Pause
            </Button>
          )}
          {snap?.paused && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => sendControl({ action: 'resume' }, 'resume')}
              disabled={busyAction !== null}
              className="h-7 px-2.5 text-[11px] gap-1 border-emerald-500/40 text-emerald-300"
            >
              <Play className="h-3 w-3" />
              Resume
            </Button>
          )}
          {(snap?.active || snap?.paused) && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => sendControl({ action: 'stop' }, 'stop')}
              disabled={busyAction !== null}
              className="h-7 px-2.5 text-[11px] gap-1 border-destructive/40 text-destructive hover:bg-destructive/10"
            >
              <Square className="h-3 w-3" />
              Stop
            </Button>
          )}

          <Button
            size="sm"
            variant={snap?.assistMode ? 'default' : 'outline'}
            onClick={() =>
              sendControl(
                { action: 'assist_toggle', enabled: !snap?.assistMode },
                'assist_toggle',
              )
            }
            disabled={busyAction !== null}
            className="h-7 px-2.5 text-[11px] gap-1"
          >
            <MousePointerClick className="h-3 w-3" />
            {snap?.assistMode ? 'Exit Login Assist' : 'Login Assist'}
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={() => sendControl({ action: 'test_login' }, 'test_login')}
            disabled={busyAction !== null}
            className="h-7 px-2.5 text-[11px] gap-1"
          >
            {busyAction === 'test_login' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            Test Login
          </Button>
        </div>
      </div>

      {actionToast && (
        <div className="border-b border-border bg-primary/10 px-4 py-1.5 text-[11px] text-foreground flex items-center justify-between">
          <span>{actionToast}</span>
          <button
            type="button"
            onClick={() => setActionToast(null)}
            className="text-muted-foreground hover:text-foreground text-[10px]"
          >
            Dismiss
          </button>
        </div>
      )}

      {expanded && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-0">
          {/* Left: Live Screenshot Viewport */}
          <div className="lg:col-span-8 border-b lg:border-b-0 lg:border-r border-border p-3 flex flex-col gap-2 bg-black/40">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <div className="flex items-center gap-2 truncate">
                <span
                  className={cn(
                    'h-2 w-2 rounded-full shrink-0',
                    streamConnected ? 'bg-emerald-400' : 'bg-amber-400',
                  )}
                  title={streamConnected ? 'Live stream active (~1 fps)' : 'Polling fallback'}
                />
                <span className="font-mono truncate max-w-[420px]">
                  {snap?.currentUrl || 'https://aistudio.google.com/prompts/new_chat'}
                </span>
              </div>
              {snap?.jobLabel && (
                <span className="font-mono text-[11px] text-emerald-300 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                  {snap.jobLabel}
                </span>
              )}
            </div>

            {snap?.assistMode && (
              <div className="flex flex-wrap items-center gap-1.5 rounded border border-sky-500/30 bg-sky-500/10 p-2 text-[11px]">
                <input
                  type="text"
                  value={assistUrl}
                  onChange={(e) => setAssistUrl(e.target.value)}
                  placeholder="https://aistudio.google.com/..."
                  className="h-7 flex-1 min-w-[180px] rounded border border-border bg-input px-2 font-mono text-[11px] text-foreground"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => sendControl({ action: 'navigate', url: assistUrl }, 'nav')}
                  className="h-7 px-2 text-[11px] gap-1"
                >
                  <ExternalLink className="h-3 w-3" />
                  Go
                </Button>
                <input
                  type="text"
                  value={assistText}
                  onChange={(e) => setAssistText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && assistText) {
                      void sendControl({ action: 'type', text: assistText }, 'type')
                      setAssistText('')
                    }
                  }}
                  placeholder="Type text into focused field..."
                  className="h-7 flex-1 min-w-[180px] rounded border border-border bg-input px-2 text-[11px] text-foreground"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (!assistText) return
                    void sendControl({ action: 'type', text: assistText }, 'type')
                    setAssistText('')
                  }}
                  className="h-7 px-2 text-[11px] gap-1"
                >
                  <Send className="h-3 w-3" />
                  Type
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => sendControl({ action: 'key', key: 'Enter' }, 'enter')}
                  className="h-7 px-2 text-[11px]"
                >
                  Enter ↵
                </Button>
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => sendControl({ action: 'save_session' }, 'save_session')}
                  className="h-7 px-2.5 text-[11px] gap-1 bg-emerald-600 hover:bg-emerald-500 text-white"
                >
                  <Save className="h-3 w-3" />
                  Save Cookies
                </Button>
              </div>
            )}

            <div className="relative aspect-16/10 w-full overflow-hidden rounded border border-border bg-zinc-950 flex items-center justify-center">
              {screenshotSrc ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    ref={imgRef}
                    src={screenshotSrc}
                    alt="Google AI Studio headless browser stream"
                    onClick={handleScreenshotClick}
                    className={cn(
                      'h-full w-full object-contain select-none',
                      snap?.assistMode ? 'cursor-crosshair' : 'cursor-default',
                    )}
                  />
                  {clickMarker && (
                    <span
                      style={{ left: `${clickMarker.xPct}%`, top: `${clickMarker.yPct}%` }}
                      className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 h-5 w-5 rounded-full border-2 border-sky-400 bg-sky-400/30 animate-ping"
                    />
                  )}
                </>
              ) : (
                <div className="flex flex-col items-center gap-2 text-center p-6 text-muted-foreground">
                  <Monitor className="h-8 w-8 opacity-40" />
                  <p className="text-xs font-medium">
                    Headless Chromium is idle. Start a Studio scan, click &ldquo;Test Login&rdquo;, or open &ldquo;Login Assist&rdquo; to view the live browser.
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Right: Live Step Log & Movie 360p Status */}
          <div className="lg:col-span-4 p-3 flex flex-col justify-between gap-3 bg-card">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <Terminal className="h-3.5 w-3.5" />
                  Automation Step Log
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {snap?.logs?.length || 0} events
                </span>
              </div>

              {scan?.movie360p && (
                <div className="rounded border border-border bg-secondary/30 p-2 text-[11px] space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-foreground">
                      Movie 360p + Drive Cache
                    </span>
                    <span className="font-mono text-[10px] uppercase text-emerald-400">
                      {scan.movie360p.status}
                    </span>
                  </div>
                  <div className="text-[10px] text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 font-mono">
                    {scan.movie360p.resolution && <span>{scan.movie360p.resolution}p @ 24fps</span>}
                    {scan.movie360p.bitrateKbps && <span>{scan.movie360p.bitrateKbps} kbps</span>}
                    {scan.movie360p.sizeBytes && (
                      <span>{(scan.movie360p.sizeBytes / (1024 * 1024)).toFixed(1)} MB</span>
                    )}
                    {scan.movie360p.driveFileName && (
                      <span className="text-emerald-300 truncate max-w-[180px]">
                        Drive: {scan.movie360p.driveFileName}
                      </span>
                    )}
                  </div>
                  {scan.movie360p.warning && (
                    <div className="text-[10px] text-amber-300 flex items-center gap-1">
                      <AlertCircle className="h-3 w-3 shrink-0" />
                      <span>{scan.movie360p.warning}</span>
                    </div>
                  )}
                </div>
              )}

              <div className="h-[260px] overflow-y-auto rounded border border-border bg-secondary/20 p-2 font-mono text-[11px] space-y-1.5">
                {snap?.logs && snap.logs.length > 0 ? (
                  snap.logs
                    .slice()
                    .reverse()
                    .map((item, idx) => (
                      <div
                        key={`${item.t}-${idx}`}
                        className="border-b border-border/50 pb-1 last:border-b-0"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={cn(
                              'font-semibold',
                              item.level === 'error'
                                ? 'text-destructive'
                                : item.level === 'warn'
                                  ? 'text-amber-300'
                                  : 'text-emerald-400',
                            )}
                          >
                            {item.step}
                          </span>
                          <span className="text-[9px] text-muted-foreground">
                            {new Date(item.t).toLocaleTimeString()}
                          </span>
                        </div>
                        {item.detail && (
                          <div className="text-[10px] text-muted-foreground break-words">
                            {item.detail}
                          </div>
                        )}
                      </div>
                    ))
                ) : (
                  <div className="text-muted-foreground text-[11px] py-8 text-center">
                    No automation steps recorded yet.
                  </div>
                )}
              </div>
            </div>

            <div className="rounded border border-border bg-secondary/20 px-2.5 py-2 text-[10px] text-muted-foreground flex items-center justify-between">
              <span>Single browser · 1 job at a time · 24 FPS</span>
              <span className="inline-flex items-center gap-1 text-emerald-400 font-medium">
                <CheckCircle2 className="h-3 w-3" />
                Selectors isolated
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
