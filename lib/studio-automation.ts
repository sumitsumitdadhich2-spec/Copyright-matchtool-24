import fs from 'fs'
import path from 'path'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { DATA_DIR } from './paths'
import {
  STUDIO_SELECTORS,
  STUDIO_URLS,
  findFirstVisibleLocator,
} from './studio-selectors'
import {
  computeEffectiveMaxInputTokens,
  loadDecryptedPlaywrightCookies,
  loadStudioUserConfig,
  saveStudioUserConfig,
} from './studio-settings'
import { buildStudioChunkPrompt } from './studio-prompt'
import { parseChunkMatches } from './gemini'
import { fmtTime } from './format'
import type { ChunkMatch } from './types'

export interface StudioStepLog {
  t: number
  step: string
  detail?: string
  level: 'info' | 'success' | 'warn' | 'error'
}

export interface StudioTestClipLine {
  label: string
  pass: boolean
  expected: string
  actual: string
  detail?: string
}

export interface StudioTestClipResult {
  status: 'running' | 'pass' | 'fail' | 'error'
  summary: string
  lines: StudioTestClipLine[]
  startedAt: number
  finishedAt?: number
}

export interface StudioLiveSnapshot {
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
  testClipResult?: StudioTestClipResult | null
}

const VIEWPORT = { width: 1366, height: 840 }

class StudioBrowserController {
  private context: BrowserContext | null = null
  private page: Page | null = null
  private launching: Promise<Page> | null = null
  private paused = false
  private stoppedScanIds = new Set<string>()
  private stoppedUsernames = new Set<string>()
  private assistMode = false
  private currentStep = 'idle'
  private scanId: string | null = null
  private activeUsername: string | null = null
  private jobLabel: string | null = null
  private tokenCount: number | null = null
  private jobStartedAt: number | null = null
  private lastScreenshotB64: string | null = null
  private lastScreenshotAt: number | null = null
  private screenshotInFlight: Promise<void> | null = null
  private logs: StudioStepLog[] = []
  private lastInjectedCookieUser: string | null = null
  private finishedJobsSinceRecycle = 0
  private testClipResult: StudioTestClipResult | null = null
  private jobLockBusy = false
  private jobLockQueue: Array<{
    scanId: string
    username: string
    grant: () => void
  }> = []

  public logStep(
    step: string,
    detail?: string,
    level: 'info' | 'success' | 'warn' | 'error' = 'info',
  ) {
    this.currentStep = detail ? `${step}: ${detail}` : step
    this.logs.push({
      t: Date.now(),
      step,
      detail,
      level,
    })
    if (this.logs.length > 80) {
      this.logs.splice(0, this.logs.length - 80)
    }
  }

  public setJobContext(scanId: string | null, jobLabel: string | null, username?: string | null) {
    this.scanId = scanId
    this.jobLabel = jobLabel
    if (username !== undefined) this.activeUsername = username
    this.jobStartedAt = scanId ? Date.now() : null
    if (!scanId) {
      this.tokenCount = null
      this.currentStep = 'idle'
      this.activeUsername = null
    }
  }

  public getActiveScanId(): string | null {
    return this.scanId
  }

  public getLoadedCookieUser(): string | null {
    return this.lastInjectedCookieUser || this.activeUsername
  }

  /**
   * FIX 6: Only allow the admin role OR the user whose cookies are currently loaded in the browser.
   */
  public canUserAccessStudio(session: { username: string; role: 'admin' | 'user' } | null): boolean {
    if (!session) return false
    if (session.role === 'admin') return true
    const cookieOwner = this.getLoadedCookieUser()
    return Boolean(cookieOwner && cookieOwner === session.username)
  }

  /**
   * FIX 6: Simple guard so only ONE Studio job runs at a time across all users (single shared browser).
   * Queues subsequent jobs in FIFO order and logs their queue position.
   */
  public async acquireJobLock(
    scanId: string,
    username: string,
    onQueued?: (position: number, msg: string) => void,
  ): Promise<() => void> {
    if (!this.jobLockBusy) {
      this.jobLockBusy = true
      return () => this.releaseJobLock()
    }

    const position = this.jobLockQueue.length + 1
    const waitMsg = `Studio browser is currently busy (active scan ${this.scanId || 'running'}) — queued at position #${position}, waiting for browser lock...`
    this.logStep('queued', waitMsg, 'info')
    onQueued?.(position, waitMsg)

    await new Promise<void>((resolve) => {
      this.jobLockQueue.push({
        scanId,
        username,
        grant: resolve,
      })
    })

    return () => this.releaseJobLock()
  }

  private releaseJobLock() {
    const next = this.jobLockQueue.shift()
    if (next) {
      next.grant()
    } else {
      this.jobLockBusy = false
    }
  }

  public setPaused(val: boolean) {
    this.paused = val
    this.logStep(val ? 'paused' : 'resumed', val ? 'User paused Studio automation' : 'User resumed Studio automation', 'warn')
  }

  public isPaused(): boolean {
    return this.paused
  }

  /**
   * FIX 6: Scope stop flag by scanId and/or username so stopping one job never stops everyone globally.
   */
  public requestStop(scope?: { scanId?: string | null; username?: string | null }) {
    const targetScanId = scope?.scanId ?? this.scanId
    const targetUsername = scope?.username ?? null
    if (targetScanId) this.stoppedScanIds.add(targetScanId)
    if (targetUsername) this.stoppedUsernames.add(targetUsername)
    if (
      (!targetScanId && !targetUsername) ||
      (targetScanId && targetScanId === this.scanId) ||
      (targetUsername && targetUsername === this.activeUsername)
    ) {
      this.paused = false
    }
    this.logStep(
      'stopping',
      `Stop requested (${targetScanId ? `scan ${targetScanId}` : targetUsername ? `user ${targetUsername}` : 'active job'})`,
      'warn',
    )
  }

  public clearStop(scope?: { scanId?: string | null; username?: string | null }) {
    if (scope?.scanId) this.stoppedScanIds.delete(scope.scanId)
    if (scope?.username) this.stoppedUsernames.delete(scope.username)
    if (!scope?.scanId && !scope?.username) {
      this.stoppedScanIds.clear()
      this.stoppedUsernames.clear()
    }
  }

  public isStopping(scope?: { scanId?: string | null; username?: string | null }): boolean {
    const checkScanId = scope?.scanId ?? this.scanId
    const checkUsername = scope?.username ?? this.activeUsername
    if (checkScanId && this.stoppedScanIds.has(checkScanId)) return true
    if (checkUsername && this.stoppedUsernames.has(checkUsername)) return true
    return false
  }

  public setAssistMode(val: boolean) {
    this.assistMode = val
    this.logStep(val ? 'login assist ON' : 'login assist OFF', undefined, 'info')
  }

  public async waitIfPausedOrThrowIfStopped(scope?: { scanId?: string | null; username?: string | null }) {
    while (this.paused && !this.isStopping(scope)) {
      await new Promise((r) => setTimeout(r, 400))
    }
    if (this.isStopping(scope)) {
      throw new Error('Studio scan stopped by user')
    }
  }

  public async ensurePage(username: string, forceReloadCookies = false): Promise<Page> {
    if (this.page && !this.page.isClosed() && this.context) {
      if (forceReloadCookies || this.lastInjectedCookieUser !== username) {
        await this.injectUserCookies(username)
      }
      return this.page
    }

    if (this.launching) return this.launching

    this.launching = (async () => {
      try {
        const profileDir = path.join(DATA_DIR, 'studio-chromium-profile')
        if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true })

        // Clean up any stale SingletonLock from an unclean container restart
        for (const lockName of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
          const lockFile = path.join(profileDir, lockName)
          try {
            if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile)
          } catch {
            /* ignore */
          }
        }

        this.logStep('browser launching', 'Starting headless Chromium persistent context')
        this.context = await chromium.launchPersistentContext(profileDir, {
          headless: true,
          viewport: VIEWPORT,
          userAgent:
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1366,840',
          ],
        })

        const pages = this.context.pages()
        this.page = pages.length > 0 ? pages[0] : await this.context.newPage()
        await this.page.setViewportSize(VIEWPORT)

        await this.injectUserCookies(username)
        return this.page
      } finally {
        this.launching = null
      }
    })()

    return this.launching
  }

  private async injectUserCookies(username: string) {
    if (!this.context) return
    const cookies = await loadDecryptedPlaywrightCookies(username)
    if (cookies.length > 0) {
      try {
        await this.context.addCookies(cookies)
        this.lastInjectedCookieUser = username
        this.logStep('cookies loaded', `${cookies.length} Google cookie(s) applied to browser session`)
      } catch (err) {
        this.logStep(
          'cookie warning',
          `Some cookies could not be added: ${err instanceof Error ? err.message : String(err)}`,
          'warn',
        )
      }
    }
  }

  public setTestClipResult(result: StudioTestClipResult | null) {
    this.testClipResult = result
  }

  public getTestClipResult(): StudioTestClipResult | null {
    return this.testClipResult
  }

  /**
   * Item 5: Page recycling — after every N finished window jobs (success or failed, default 5),
   * close the Playwright page and open a fresh page in the SAME persistent context (cookies kept),
   * then continue. Logs "page recycled" in the step log.
   */
  public async recordFinishedWindowJobAndMaybeRecyclePage(
    username: string,
    recycleInterval?: number,
    onLog?: (level: 'info' | 'warn' | 'error' | 'success', msg: string) => void,
  ): Promise<void> {
    this.finishedJobsSinceRecycle += 1
    let interval = recycleInterval
    if (!interval || interval < 1) {
      const cfg = await loadStudioUserConfig(username)
      interval = cfg.studioPageRecycleInterval || 5
    }
    if (this.finishedJobsSinceRecycle < interval) return

    const count = this.finishedJobsSinceRecycle
    this.finishedJobsSinceRecycle = 0
    if (!this.context) return

    try {
      const oldPage = this.page
      const freshPage = await this.context.newPage()
      await freshPage.setViewportSize(VIEWPORT)
      this.page = freshPage
      if (oldPage && !oldPage.isClosed()) {
        await oldPage.close().catch(() => {})
      }
      const detail = `Closed old page and opened fresh page in same persistent context after ${count} finished window job(s) (interval=${interval})`
      this.logStep('page recycled', detail, 'info')
      onLog?.('info', `[Studio] page recycled: ${detail}`)
    } catch (err) {
      this.logStep(
        'page recycle warning',
        err instanceof Error ? err.message : String(err),
        'warn',
      )
    }
  }

  /**
   * FIX 6: Capture at most ONE screenshot per second TOTAL across all connected SSE clients.
   */
  public async getSnapshot(captureFresh = true): Promise<StudioLiveSnapshot> {
    if (captureFresh && this.page && !this.page.isClosed()) {
      const now = Date.now()
      if (!this.lastScreenshotAt || now - this.lastScreenshotAt >= 1000) {
        if (!this.screenshotInFlight) {
          this.screenshotInFlight = (async () => {
            try {
              if (!this.page || this.page.isClosed()) return
              const buf = await this.page.screenshot({
                type: 'jpeg',
                quality: 62,
                timeout: 2500,
              })
              this.lastScreenshotB64 = buf.toString('base64')
              this.lastScreenshotAt = Date.now()
            } catch {
              /* ignore screenshot race while navigating */
            } finally {
              this.screenshotInFlight = null
            }
          })()
        }
        await this.screenshotInFlight
      }
    }

    const elapsedSec = this.jobStartedAt ? Math.round((Date.now() - this.jobStartedAt) / 1000) : 0
    return {
      active: Boolean(this.page && !this.page.isClosed()),
      paused: this.paused,
      assistMode: this.assistMode,
      currentStep: this.currentStep,
      currentUrl: this.page && !this.page.isClosed() ? this.page.url() : '',
      scanId: this.scanId,
      jobLabel: this.jobLabel,
      tokenCount: this.tokenCount,
      elapsedSec,
      screenshotBase64: this.lastScreenshotB64,
      screenshotAt: this.lastScreenshotAt,
      viewport: VIEWPORT,
      logs: this.logs.slice(-30),
      testClipResult: this.testClipResult,
    }
  }

  /**
   * Interactive Login Assist actions from the Live View panel (click, type, key, navigate).
   */
  public async performAssistAction(
    username: string,
    action:
      | { type: 'click'; xRatio: number; yRatio: number }
      | { type: 'type'; text: string }
      | { type: 'key'; key: string }
      | { type: 'navigate'; url: string }
      | { type: 'save_session' },
  ): Promise<StudioLiveSnapshot> {
    const page = await this.ensurePage(username)
    if (action.type === 'click') {
      const x = Math.round(Math.max(0, Math.min(1, action.xRatio)) * VIEWPORT.width)
      const y = Math.round(Math.max(0, Math.min(1, action.yRatio)) * VIEWPORT.height)
      await page.mouse.click(x, y)
      this.logStep('assist click', `Clicked (${x}, ${y})`)
    } else if (action.type === 'type') {
      await page.keyboard.type(action.text, { delay: 35 })
      this.logStep('assist type', `Typed ${action.text.length} char(s)`)
    } else if (action.type === 'key') {
      await page.keyboard.press(action.key)
      this.logStep('assist key', `Pressed ${action.key}`)
    } else if (action.type === 'navigate') {
      await page.goto(action.url || STUDIO_URLS.newChat, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      this.logStep('assist navigate', page.url())
    } else if (action.type === 'save_session' && this.context) {
      const state = await this.context.storageState()
      const { saveUserGoogleCookies } = await import('./studio-settings')
      await saveUserGoogleCookies(username, JSON.stringify(state))
      this.logStep('session saved', `Saved ${state.cookies.length} cookies from live browser`, 'success')
    }
    await new Promise((r) => setTimeout(r, 350))
    return this.getSnapshot(true)
  }

  /**
   * Test login on aistudio.google.com and return whether the session is authenticated + account email.
   */
  public async testLogin(username: string): Promise<{
    loggedIn: boolean
    email: string | null
    currentUrl: string
    message: string
  }> {
    const page = await this.ensurePage(username, true)
    this.logStep('testing login', 'Opening aistudio.google.com/prompts/new_chat...')

    try {
      await page.goto(STUDIO_URLS.newChat, {
        waitUntil: 'domcontentloaded',
        timeout: 40_000,
      })
    } catch (err) {
      this.logStep('navigation warning', err instanceof Error ? err.message : String(err), 'warn')
    }

    await new Promise((r) => setTimeout(r, 3500))
    await this.dismissAnyOnboardingModals(page)

    const url = page.url()
    const isGoogleLoginRedirect =
      url.includes('accounts.google.com') ||
      url.includes('ServiceLogin') ||
      url.includes('InteractiveLogin')

    let email: string | null = null
    try {
      email = await page.evaluate(() => {
        // Look for email in aria-labels or page text
        const els = Array.from(document.querySelectorAll('[aria-label], [title], [data-email]'))
        for (const el of els) {
          const text =
            (el.getAttribute('data-email') || '') +
            ' ' +
            (el.getAttribute('aria-label') || '') +
            ' ' +
            (el.getAttribute('title') || '')
          const m = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/)
          if (m) return m[1]
        }
        const bodyMatch = document.body.innerText.match(/([a-zA-Z0-9._%+-]+@gmail\.com)/i)
        return bodyMatch ? bodyMatch[1] : null
      })
    } catch {
      /* ignore */
    }

    const promptLoc = await findFirstVisibleLocator(page, STUDIO_SELECTORS.promptInput, 4000)
    const loggedIn = !isGoogleLoginRedirect && Boolean(promptLoc || url.includes('aistudio.google.com/prompts') || url.includes('aistudio.google.com/app'))

    await saveStudioUserConfig(username, {
      lastLoginStatus: loggedIn ? 'logged_in' : 'logged_out',
      lastLoginEmail: email,
      lastLoginTestedAt: Date.now(),
    })

    if (loggedIn) {
      const msg = `Logged in to Google AI Studio${email ? ` as ${email}` : ''}`
      this.logStep('login verified', msg, 'success')
      return { loggedIn: true, email, currentUrl: url, message: msg }
    } else {
      const msg = isGoogleLoginRedirect
        ? 'Redirected to Google Sign-In (cookies expired or verification needed — use Login Assist in Live View or paste fresh cookies)'
        : `Could not confirm AI Studio workspace at ${url}`
      this.logStep('login failed', msg, 'error')
      return { loggedIn: false, email: null, currentUrl: url, message: msg }
    }
  }

  public async dismissAnyOnboardingModals(page: Page) {
    for (const sel of STUDIO_SELECTORS.dismissDialogs) {
      try {
        const btn = page.locator(sel).first()
        if ((await btn.count()) > 0 && (await btn.isVisible())) {
          await btn.click({ timeout: 1500 })
          await new Promise((r) => setTimeout(r, 300))
        }
      } catch {
        /* ignore */
      }
    }
  }

  private formatClockForStudioInput(sec: number): string {
    const total = Math.max(0, Math.floor(sec))
    if (total === 0) return '0s'
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    const parts: string[] = []
    if (h > 0) parts.push(`${h}h`)
    if (m > 0) parts.push(`${m}m`)
    if (s > 0) parts.push(`${s}s`)
    return parts.join('')
  }

  /**
   * Parse a clock/time string read back from Studio's video settings input
   * (e.g. "0s", "5m", "1m10s", "05:00", "1:05:00", "300", "05m 00s") into seconds.
   */
  private parseStudioClockToSec(raw: string | null | undefined): number | null {
    if (!raw) return null
    const str = raw.trim()
    if (!str) return null

    // HH:MM:SS or MM:SS
    const colonParts = str.split(':').map((p) => p.trim())
    if (colonParts.length === 2 || colonParts.length === 3) {
      const nums = colonParts.map((p) => Number(p))
      if (nums.every((n) => Number.isFinite(n) && n >= 0)) {
        if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2]
        return nums[0] * 60 + nums[1]
      }
    }

    // e.g. "5m 30s", "1m10s", "5m", "0s", "120s"
    const msMatch = str.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s?)?$/i)
    if (msMatch && (msMatch[1] || msMatch[2] || msMatch[3])) {
      const h = msMatch[1] ? Number(msMatch[1]) : 0
      const m = msMatch[2] ? Number(msMatch[2]) : 0
      const s = msMatch[3] ? Number(msMatch[3]) : 0
      if (Number.isFinite(h) && Number.isFinite(m) && Number.isFinite(s)) {
        return h * 3600 + m * 60 + s
      }
    }

    const plain = Number(str)
    return Number.isFinite(plain) && plain >= 0 ? plain : null
  }

  /**
   * Problem 2(d): Dump the Run Settings panel HTML + controls to the step log when
   * model list / thinking level dropdown selectors are not found or verification fails.
   */
  private async dumpRunSettingsPanelDiagnostics(page: Page, reason: string): Promise<void> {
    try {
      const dump = await page.evaluate(() => {
        const isVisible = (el: Element | null): el is HTMLElement => {
          if (!el) return false
          const h = el as HTMLElement
          const r = h.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && window.getComputedStyle(h).visibility !== 'hidden'
        }

        const panelCandidates = Array.from(
          document.querySelectorAll(
            'ms-run-settings, ms-runsettings, ms-run-settings-panel, ms-runsettings-panel, [class*="runsettings-panel" i], [class*="run-settings-panel" i], [class*="runsettings" i]:not(button):not([class*="toggle" i]), [class*="run-settings" i]:not(button):not([class*="toggle" i]), aside, .right-side-panel, [data-test-id*="run-settings" i], [data-test-id*="runsettings" i]',
          ),
        ).filter((el) => {
          if (!isVisible(el)) return false
          const r = el.getBoundingClientRect()
          return r.width >= 140 && r.height >= 100
        })

        let panelEl: HTMLElement | null = (panelCandidates[0] as HTMLElement | undefined) || null
        if (!panelEl) {
          // Fallback: find any right-side container holding Run Settings controls
          const rightContainers = Array.from(document.body.querySelectorAll('div, section, aside')).filter((el) => {
            if (!isVisible(el)) return false
            const r = el.getBoundingClientRect()
            return (
              r.left >= window.innerWidth * 0.45 &&
              r.width >= 180 &&
              r.width <= 650 &&
              r.height >= 220 &&
              /temperature|thinking|safety|resolution|token|system\s+instructions/i.test(
                (el as HTMLElement).innerText || '',
              )
            )
          })
          panelEl = (rightContainers[0] as HTMLElement) || null
        }

        const overlayPanes = Array.from(
          document.querySelectorAll('.cdk-overlay-pane, [role="listbox"], [role="menu"], [role="dialog"]'),
        )
          .filter((el) => (el.textContent || '').trim().length > 0)
          .map((el) => el.outerHTML.slice(0, 1500))
          .join(' || ')

        const panelHtml = panelEl
          ? panelEl.outerHTML.slice(0, 3000)
          : `No run-settings panel open. Body snippet: ${(document.body.innerText || '').slice(0, 800)}`

        const controls = Array.from(
          (panelEl || document.body).querySelectorAll(
            'ms-model-selector, button, mat-select, [role="combobox"], [role="listbox"], [role="option"], mat-option, mat-slide-toggle, input',
          ),
        )
          .slice(0, 45)
          .map((c) => {
            const tag = c.tagName.toLowerCase()
            const aria = c.getAttribute('aria-label') || ''
            const role = c.getAttribute('role') || ''
            const cls = (c.getAttribute('class') || '').slice(0, 60)
            const txt = ((c as HTMLElement).innerText || c.textContent || '')
              .trim()
              .replace(/\s+/g, ' ')
              .slice(0, 80)
            return `<${tag}${role ? ` role="${role}"` : ''}${aria ? ` aria="${aria}"` : ''}${cls ? ` class="${cls}"` : ''}>"${txt}"`
          })
          .join(' ; ')

        return {
          panelHtml,
          overlayHtml: overlayPanes.slice(0, 2000),
          controls: controls.slice(0, 3000),
        }
      })

      this.logStep(`diag panel HTML`, `${reason} :: ${dump.panelHtml}`, 'warn')
      if (dump.overlayHtml) {
        this.logStep(`diag overlay HTML`, dump.overlayHtml, 'warn')
      }
      this.logStep(`diag panel controls`, dump.controls || 'none', 'warn')
      console.warn(`[Studio RunSettings Diag] ${reason} :: panelHtml:`, dump.panelHtml)
      if (dump.overlayHtml) {
        console.warn(`[Studio RunSettings Diag] overlayHtml:`, dump.overlayHtml)
      }
      console.warn(`[Studio RunSettings Diag] controls:`, dump.controls)
    } catch (err) {
      this.logStep('diag panel err', (err as Error).message, 'warn')
    }
  }

  /**
   * Check whether the right-hand Run Settings panel is currently open and visible.
   * Note: Gemini 3.8 Flash does NOT have a "Temperature" field in Run Settings —
   * it shows "Run settings", "System instructions", "Thinking level", "Media resolution", "Output length".
   */
  private async isRunSettingsPanelOpen(page: Page): Promise<boolean> {
    try {
      return await page.evaluate(() => {
        const isVisible = (el: Element | null): el is HTMLElement => {
          if (!el) return false
          const h = el as HTMLElement
          const r = h.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && window.getComputedStyle(h).visibility !== 'hidden'
        }

        const containers = Array.from(
          document.querySelectorAll(
            'ms-run-settings, ms-runsettings, ms-run-settings-panel, ms-runsettings-panel, [class*="runsettings-panel" i], [class*="run-settings-panel" i], [class*="runsettings" i]:not(button):not([class*="toggle" i]), [class*="run-settings" i]:not(button):not([class*="toggle" i]), ms-model-selector',
          ),
        )
        for (const c of containers) {
          if (!isVisible(c)) continue
          const tag = c.tagName.toLowerCase()
          if (tag === 'button') continue
          const r = c.getBoundingClientRect()
          if (r.width >= 150 && r.height >= 60) return true
        }

        const bodyText = document.body.innerText || ''
        if (
          /thinking\s+level/i.test(bodyText) ||
          /media\s+resolution/i.test(bodyText) ||
          /output\s+length/i.test(bodyText) ||
          (/system\s+instructions/i.test(bodyText) && /run\s+settings/i.test(bodyText)) ||
          (/temperature/i.test(bodyText) && /run\s+settings/i.test(bodyText))
        ) {
          return true
        }
        return false
      })
    } catch {
      return false
    }
  }

  /**
   * Dismiss any open dropdown / menu overlay (.cdk-overlay-backdrop) WITHOUT accidentally closing
   * the Run Settings panel via an unnecessary Escape press.
   */
  private async dismissOpenOverlayIfAny(page: Page): Promise<void> {
    try {
      const closedViaBackdrop = await page.evaluate(() => {
        const backdrop = document.querySelector('.cdk-overlay-backdrop.cdk-overlay-backdrop-showing') as HTMLElement | null
        if (backdrop) {
          backdrop.click()
          return true
        }
        const activeOverlay = document.querySelector(
          '.cdk-overlay-pane [role="menu"], .cdk-overlay-pane [role="listbox"], .cdk-overlay-pane mat-option',
        ) as HTMLElement | null
        if (activeOverlay && activeOverlay.getBoundingClientRect().height > 0) {
          return false // needs Escape
        }
        return true // nothing open
      })
      if (!closedViaBackdrop) {
        await page.keyboard.press('Escape').catch(() => {})
      }
      await new Promise((r) => setTimeout(r, 200))
    } catch {
      /* ignore */
    }
  }

  /**
   * Ensure the right-hand Run Settings panel is open.
   * Never clicks the toggle button if the panel is already open; if closed, clicks
   * `button[aria-label="Toggle run settings panel"]` (`button.runsettings-toggle-button`)
   * and polls until the panel is visibly open.
   */
  private async ensureRunSettingsPanelOpen(page: Page): Promise<boolean> {
    if (await this.isRunSettingsPanelOpen(page)) return true
    await new Promise((r) => setTimeout(r, 300))
    if (await this.isRunSettingsPanelOpen(page)) return true

    await this.dismissOpenOverlayIfAny(page)
    if (await this.isRunSettingsPanelOpen(page)) return true

    const toggle = await findFirstVisibleLocator(page, STUDIO_SELECTORS.runSettingsToggle, 2500)
    if (toggle) {
      await toggle.click().catch(() => {})
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 250))
        if (await this.isRunSettingsPanelOpen(page)) return true
      }
    }

    // Second attempt via direct DOM click on button.runsettings-toggle-button
    const clickedDom = await page
      .evaluate(() => {
        const btn = document.querySelector(
          'button[aria-label="Toggle run settings panel" i], button.runsettings-toggle-button, button[aria-label*="Run settings" i]',
        ) as HTMLElement | null
        if (btn) {
          btn.click()
          return true
        }
        return false
      })
      .catch(() => false)

    if (clickedDom) {
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 250))
        if (await this.isRunSettingsPanelOpen(page)) return true
      }
    }

    return await this.isRunSettingsPanelOpen(page)
  }

  /**
   * Close the Run Settings panel after configuring model & thinking level so it does not cover
   * the prompt composer or the Run button (as shown at 01:42-01:48 in the user's video).
   */
  private async closeRunSettingsPanel(page: Page): Promise<void> {
    try {
      await this.dismissOpenOverlayIfAny(page)
      if (!(await this.isRunSettingsPanelOpen(page))) return

      await page
        .evaluate(() => {
          const isVisible = (el: Element | null): el is HTMLElement => {
            if (!el) return false
            const h = el as HTMLElement
            const r = h.getBoundingClientRect()
            return r.width > 0 && r.height > 0 && window.getComputedStyle(h).visibility !== 'hidden'
          }

          // 1. Try the close (X) button at the top-right of the Run settings panel header
          const closeBtns = Array.from(
            document.querySelectorAll(
              'button[aria-label*="Close run settings" i], button[aria-label="Close panel" i], button[aria-label="Close" i]',
            ),
          )
          for (const b of closeBtns) {
            if (isVisible(b) && b.getBoundingClientRect().left > window.innerWidth * 0.45) {
              ;(b as HTMLElement).click()
              return
            }
          }

          // 2. Fallback: click the tune toggle button in the top toolbar
          const toggleBtn = document.querySelector(
            'button[aria-label="Toggle run settings panel" i], button.runsettings-toggle-button',
          ) as HTMLElement | null
          if (toggleBtn && isVisible(toggleBtn)) {
            toggleBtn.click()
          }
        })
        .catch(() => {})

      await new Promise((r) => setTimeout(r, 350))
    } catch {
      /* ignore */
    }
  }

  /**
   * Read the currently visible model card text at the top of the Run Settings panel.
   * Excludes the center-page welcome heading ("Start building with Gemini 3.8 Flash").
   */
  private async readVisibleModelCardText(page: Page): Promise<string> {
    try {
      return await page.evaluate((triggerSels) => {
        const isVisible = (el: Element | null): el is HTMLElement => {
          if (!el) return false
          const h = el as HTMLElement
          const r = h.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && window.getComputedStyle(h).visibility !== 'hidden'
        }

        const isWelcomeHeading = (txt: string) => /^start\s+building\s+with\b/i.test(txt)

        for (const sel of triggerSels) {
          const nodes = Array.from(document.querySelectorAll(sel))
          for (const node of nodes) {
            if (!isVisible(node)) continue
            const t = (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ')
            if (t && !isWelcomeHeading(t) && (/gemini/i.test(t) || /3\.8/i.test(t) || /2\.5/i.test(t))) {
              return t
            }
          }
        }

        // Search inside the Run Settings panel (or right-hand panel region) for the model card
        const panelRoot =
          (Array.from(
            document.querySelectorAll(
              'ms-run-settings, ms-runsettings, ms-run-settings-panel, ms-runsettings-panel, [class*="runsettings-panel" i], [class*="run-settings-panel" i], [class*="runsettings" i]:not(button):not([class*="toggle" i]), [class*="run-settings" i]:not(button):not([class*="toggle" i])',
            ),
          ).find((el) => isVisible(el) && el.getBoundingClientRect().width >= 150) as HTMLElement | undefined) ||
          null

        const searchRoot = panelRoot || document.body
        const all = Array.from(
          searchRoot.querySelectorAll(
            'ms-model-selector, [class*="model-selector" i], [data-test-id*="model" i], button, a, [role="button"], [role="combobox"], div, span',
          ),
        )
        for (const node of all) {
          if (!isVisible(node)) continue
          const r = node.getBoundingClientRect()
          // If searching document.body, restrict to right-hand Run Settings area and exclude center welcome card
          if (!panelRoot && r.left < window.innerWidth * 0.45) continue
          if (r.height > 150 || r.width > 550 || r.width < 40) continue
          const t = (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ')
          if (!t || isWelcomeHeading(t)) continue
          if (
            /^gemini[\s-]+\d+(\.\d+)?/i.test(t) ||
            /\bgemini[\s-]+3\.8\b/i.test(t) ||
            /\bgemini[\s-]+2\.5\b/i.test(t)
          ) {
            return t
          }
        }
        return ''
      }, [...STUDIO_SELECTORS.modelSelectorTrigger])
    } catch {
      return ''
    }
  }

  /**
   * Read the currently visible text of the "Thinking level" dropdown in the Run Settings panel.
   */
  private async readVisibleThinkingLevelText(page: Page): Promise<string> {
    try {
      return await page.evaluate((thinkSels) => {
        const isVisible = (el: Element | null): el is HTMLElement => {
          if (!el) return false
          const h = el as HTMLElement
          const r = h.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && window.getComputedStyle(h).visibility !== 'hidden'
        }

        for (const sel of thinkSels) {
          const nodes = Array.from(document.querySelectorAll(sel))
          for (const node of nodes) {
            if (!isVisible(node)) continue
            const t = (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ')
            if (t) return t
          }
        }

        // Row-scoped lookup: find the compact row containing "Thinking level" (or "Thinking budget") and read its dropdown/button/selected value
        const all = Array.from(document.body.querySelectorAll('*'))
        const labelNodes = all.filter((el) => {
          if (!isVisible(el)) return false
          const t = ((el as HTMLElement).innerText || el.textContent || '').trim()
          return /^thinking\s+(level|budget)$/i.test(t)
        })

        for (const lbl of labelNodes) {
          let row: Element | null = lbl.parentElement
          for (let depth = 0; depth < 6 && row; depth++) {
            const r = row.getBoundingClientRect()
            if (r.height >= 18 && r.height <= 160 && r.width <= 600) {
              // Check for active/checked segmented button first (if rendered as Low/Medium/High buttons)
              const pressedBtn = row.querySelector(
                'button[aria-pressed="true"], button[aria-selected="true"], .mat-button-toggle-checked, [class*="active" i][role="button"], [class*="selected" i] button',
              ) as HTMLElement | null
              if (pressedBtn && isVisible(pressedBtn)) {
                const pVal = (pressedBtn.innerText || pressedBtn.textContent || '').trim().replace(/\s+/g, ' ')
                if (pVal) return pVal
              }

              const ctrl = row.querySelector(
                'mat-select, [role="combobox"], button[aria-haspopup], select, .mat-mdc-select-value, .mat-mdc-select-trigger, button:not([aria-label*="info" i]):not([aria-label*="help" i]):not([role="switch"])',
              ) as HTMLElement | null
              if (ctrl && isVisible(ctrl) && ctrl !== lbl && !ctrl.contains(lbl)) {
                const val = (ctrl.innerText || ctrl.textContent || (ctrl as HTMLInputElement).value || '')
                  .trim()
                  .replace(/\s+/g, ' ')
                if (val && !/^thinking\s+(level|budget)$/i.test(val)) {
                  return val
                }
              }
            }
            row = row.parentElement
          }
        }
        return ''
      }, [...STUDIO_SELECTORS.thinkingLevelSelect])
    } catch {
      return ''
    }
  }

  /**
   * Tag the dropdown control (mat-select / [role="combobox"] / button) inside a compact
   * Run Settings row identified by its label text (e.g. "Thinking level" or "Media resolution")
   * with `data-cmt-row-select="<attrVal>"` so Playwright can click it without matching unrelated dropdowns.
   */
  private async markRowDropdownByLabel(
    page: Page,
    rowLabelRegexSource: string,
    attrVal: string,
  ): Promise<boolean> {
    try {
      return await page.evaluate(
        ({ regexSrc, marker }) => {
          document
            .querySelectorAll(`[data-cmt-row-select="${marker}"]`)
            .forEach((el) => el.removeAttribute('data-cmt-row-select'))

          const re = new RegExp(regexSrc, 'i')
          const isVisible = (el: Element | null): el is HTMLElement => {
            if (!el) return false
            const h = el as HTMLElement
            const r = h.getBoundingClientRect()
            return r.width > 0 && r.height > 0 && window.getComputedStyle(h).visibility !== 'hidden'
          }

          const all = Array.from(document.body.querySelectorAll('*'))
          const labelLeaves = all.filter((el) => {
            if (!isVisible(el)) return false
            if (el.children.length > 2) return false
            const t = ((el as HTMLElement).innerText || el.textContent || '').trim()
            return re.test(t) && t.length <= 40
          })

          for (const leaf of labelLeaves) {
            let row: Element | null = leaf.parentElement
            for (let depth = 0; depth < 6 && row; depth++) {
              const r = row.getBoundingClientRect()
              if (r.height >= 18 && r.height <= 165 && r.width <= 600) {
                const ctrl = row.querySelector(
                  'mat-select, [role="combobox"], button[aria-haspopup], select, .mat-mdc-select-trigger, button:not([aria-label*="info" i]):not([aria-label*="help" i]):not([role="switch"])',
                ) as HTMLElement | null
                if (ctrl && isVisible(ctrl) && ctrl !== leaf && !ctrl.contains(leaf)) {
                  ctrl.setAttribute('data-cmt-row-select', marker)
                  return true
                }
              }
              row = row.parentElement
            }
          }
          return false
        },
        { regexSrc: rowLabelRegexSource, marker: attrVal },
      )
    } catch {
      return false
    }
  }

  /**
   * Step (b): Configure model name (default 'Gemini 3.8 Flash', excluding TTS),
   * Thinking level = High, media resolution = Low/Medium, max output tokens,
   * and safety settings all OFF. Then close the Run Settings panel so the prompt area is unobstructed.
   */
  private async configureRunSettings(
    page: Page,
    config: { modelName: string; maxOutputTokens: number },
    scope?: { scanId?: string | null; username?: string | null },
  ) {
    await this.waitIfPausedOrThrowIfStopped(scope)

    // 0. Ensure Run Settings panel is open (without closing it if already open!)
    const panelOpened = await this.ensureRunSettingsPanelOpen(page)
    if (!panelOpened) {
      await this.dumpRunSettingsPanelDiagnostics(page, 'Run settings panel did not open after clicking toggle')
    }

    // 1. Select Model (prefer configured studioModelName, default 'Gemini 3.8 Flash'; never pick TTS)
    const rawTargetModel = (config.modelName || 'Gemini 3.8 Flash').trim()
    const targetModel =
      rawTargetModel === 'Gemini 2.5 Pro' || rawTargetModel === 'Gemini 3.8 Pro'
        ? 'Gemini 3.8 Flash'
        : rawTargetModel
    let verifiedModelText = ''
    let modelConfigError = ''

    const normalizeModelStr = (s: string) =>
      s
        .toLowerCase()
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

    for (let modelAttempt = 1; modelAttempt <= 2; modelAttempt++) {
      await this.waitIfPausedOrThrowIfStopped(scope)
      modelConfigError = ''

      await this.ensureRunSettingsPanelOpen(page)

      const currentCardText = await this.readVisibleModelCardText(page)
      const targetNorm = normalizeModelStr(targetModel)
      const currentNorm = normalizeModelStr(currentCardText)

      // Check if current model card in Run Settings already matches "Gemini 3.8 Flash" (and is NOT "Gemini 3.8 Flash TTS")
      if (
        currentNorm &&
        !/\btts\b/i.test(currentNorm) &&
        (currentNorm.includes(targetNorm) ||
          (targetNorm.includes('3.8 flash') && /3\.8\s*flash/i.test(currentNorm)))
      ) {
        verifiedModelText = currentCardText
        this.logStep('model verified', `Run settings model already set to "${currentCardText}"`, 'info')
        break
      }

      // Click the model selector card at the top of the Run Settings panel to open the Model Selection view
      let clickedTrigger = false
      const triggerLoc = await findFirstVisibleLocator(page, STUDIO_SELECTORS.modelSelectorTrigger, 1800)
      if (triggerLoc) {
        await triggerLoc.scrollIntoViewIfNeeded().catch(() => {})
        await triggerLoc.click().catch(() => {})
        clickedTrigger = true
      } else {
        // Fallback: find the visible model card / button inside the Run Settings panel (right side of viewport, never the top toolbar or center welcome text)
        const markedCard = await page
          .evaluate(() => {
            document
              .querySelectorAll('[data-cmt-model-card]')
              .forEach((el) => el.removeAttribute('data-cmt-model-card'))

            const isVisible = (el: Element | null): el is HTMLElement => {
              if (!el) return false
              const h = el as HTMLElement
              const r = h.getBoundingClientRect()
              return r.width > 0 && r.height > 0 && window.getComputedStyle(h).visibility !== 'hidden'
            }

            const panelRoot =
              (Array.from(
                document.querySelectorAll(
                  'ms-run-settings, ms-runsettings, ms-run-settings-panel, ms-runsettings-panel, [class*="runsettings-panel" i], [class*="run-settings-panel" i], [class*="runsettings" i]:not(button):not([class*="toggle" i]), [class*="run-settings" i]:not(button):not([class*="toggle" i])',
                ),
              ).find((el) => isVisible(el) && el.getBoundingClientRect().width >= 150) as HTMLElement | undefined) ||
              null

            const searchRoot = panelRoot || document.body
            const candidates = Array.from(
              searchRoot.querySelectorAll(
                'ms-model-selector, [class*="model-selector" i], [data-test-id*="model" i], button, [role="button"], [role="combobox"], a, div',
              ),
            )
            for (const c of candidates) {
              const el = c as HTMLElement
              if (!isVisible(el)) continue
              const r = el.getBoundingClientRect()
              if (!panelRoot && r.left < window.innerWidth * 0.45) continue
              if (r.width < 40 || r.width > 550 || r.height < 20 || r.height > 150) continue
              const aria = (el.getAttribute('aria-label') || '').toLowerCase()
              if (
                aria.includes('view more actions') ||
                aria.includes('toggle run settings') ||
                aria.includes('reset settings') ||
                aria.includes('get sdk') ||
                aria.includes('get code')
              ) {
                continue
              }
              const t = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ')
              if (/^start\s+building\s+with\b/i.test(t)) continue
              if (/gemini[\s-]+\d+(\.\d+)?/i.test(t)) {
                const btn = el.querySelector(
                  'button:not([aria-label*="View more actions" i]):not([aria-label*="Toggle run settings" i]), [role="button"], [role="combobox"]',
                ) as HTMLElement | null
                ;(btn || el).setAttribute('data-cmt-model-card', 'true')
                return true
              }
            }
            return false
          })
          .catch(() => false)

        if (markedCard) {
          const fallbackCard = page.locator('[data-cmt-model-card="true"]').first()
          if ((await fallbackCard.count()) > 0) {
            await fallbackCard.scrollIntoViewIfNeeded().catch(() => {})
            await fallbackCard.click().catch(() => {})
            clickedTrigger = true
          }
        }
      }

      await new Promise((r) => setTimeout(r, 500))

      // Inspect options in the opened "Model selection" panel / overlay and click the best match:
      // 1) "Gemini 3.8 Flash" / "gemini-3.8-flash" (excluding "TTS")
      // 2) exact/substring match for targetModel (excluding "TTS")
      // 3) first entry containing "3.8" (excluding "TTS")
      const pickResult = await page
        .evaluate((desiredModel) => {
          const isVisible = (el: Element): el is HTMLElement => {
            const h = el as HTMLElement
            const r = h.getBoundingClientRect()
            return r.width > 0 && r.height > 0 && window.getComputedStyle(h).visibility !== 'hidden'
          }

          const norm = (s: string) =>
            s
              .toLowerCase()
              .replace(/[-_]+/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()

          document
            .querySelectorAll('[data-cmt-picked-model]')
            .forEach((el) => el.removeAttribute('data-cmt-picked-model'))

          const rawOptions = Array.from(
            document.querySelectorAll(
              'mat-option, [role="option"], [role="menuitem"], ms-model-option, .model-option, button, [role="button"], div[class*="option" i], div[class*="item" i], div[class*="card" i], div[class*="model" i], li',
            ),
          ).filter((el) => {
            if (!isVisible(el)) return false
            const r = el.getBoundingClientRect()
            // Model selection list is on the right side or in an overlay pane
            if (r.left < window.innerWidth * 0.35 && !el.closest('.cdk-overlay-pane')) return false
            if (r.height < 24 || r.height > 180 || r.width < 120 || r.width > 600) return false
            const t = ((el as HTMLElement).innerText || el.textContent || '').trim()
            if (/^start\s+building\s+with\b/i.test(t)) return false
            if (/^model\s+selection/i.test(t)) return false
            return (
              t.length > 0 &&
              t.length < 320 &&
              (/gemini/i.test(t) || /3\.8/i.test(t) || /2\.5/i.test(t))
            )
          })

          // Keep minimal option cards so we don't pick a wrapper div containing multiple models
          const options = rawOptions.filter(
            (el) => !rawOptions.some((child) => child !== el && el.contains(child)),
          )

          if (options.length === 0) {
            return { foundList: false, pickedText: '', usedFallback: false, available: [] as string[] }
          }

          const entries = options.map((el) => ({
            el: el as HTMLElement,
            text: ((el as HTMLElement).innerText || el.textContent || '').trim().replace(/\s+/g, ' '),
            normText: norm(((el as HTMLElement).innerText || el.textContent || '').trim()),
          }))

          const nonTtsEntries = entries.filter((e) => !/\btts\b/i.test(e.normText))
          const pool = nonTtsEntries.length > 0 ? nonTtsEntries : entries

          const desiredNorm = norm(desiredModel)
          let chosen = pool.find((e) => e.normText.includes(desiredNorm))
          let usedFallback = false

          if (!chosen) {
            usedFallback = true
            chosen =
              pool.find((e) => /gemini\s*3\.8\s*flash/i.test(e.normText)) ||
              pool.find((e) => /3\.8\s*flash/i.test(e.normText)) ||
              pool.find((e) => /gemini\s*3\.8\s*pro/i.test(e.normText)) ||
              pool.find((e) => /3\.8\s*pro/i.test(e.normText)) ||
              pool.find((e) => /3\.8/i.test(e.normText)) ||
              undefined
          }

          if (chosen) {
            chosen.el.setAttribute('data-cmt-picked-model', 'true')
            return {
              foundList: true,
              pickedText: chosen.text,
              usedFallback,
              available: entries.map((e) => e.text),
            }
          }

          return {
            foundList: true,
            pickedText: '',
            usedFallback: false,
            available: entries.map((e) => e.text),
          }
        }, targetModel)
        .catch(() => ({ foundList: false, pickedText: '', usedFallback: false, available: [] as string[] }))

      let expectedSubstringAfterPick = targetNorm

      if (pickResult.pickedText) {
        const pickedLoc = page.locator('[data-cmt-picked-model="true"]').first()
        if ((await pickedLoc.count()) > 0) {
          await pickedLoc.scrollIntoViewIfNeeded().catch(() => {})
          await pickedLoc.click().catch(() => {})
        }
        if (pickResult.usedFallback) {
          this.logStep(
            'model fallback',
            `"${targetModel}" not in list; selected "${pickResult.pickedText}"`,
            'info',
          )
          expectedSubstringAfterPick = /3\.8\s*flash/i.test(pickResult.pickedText)
            ? '3.8 flash'
            : /3\.8\s*pro/i.test(pickResult.pickedText)
              ? '3.8 pro'
              : '3.8'
        }
        await new Promise((r) => setTimeout(r, 500))
        await this.dismissOpenOverlayIfAny(page)
      } else {
        if (!clickedTrigger) {
          await this.dumpRunSettingsPanelDiagnostics(
            page,
            `model selector trigger not found (attempt ${modelAttempt}/2)`,
          )
        } else {
          await this.dumpRunSettingsPanelDiagnostics(
            page,
            `model option "${targetModel}" (or "3.8") not found in model list (foundList=${pickResult.foundList}, available=${pickResult.available.join(' | ') || 'none'})`,
          )
        }
        await this.dismissOpenOverlayIfAny(page)
        if (
          pickResult.foundList &&
          !pickResult.available.some((a) => normalizeModelStr(a).includes(targetNorm)) &&
          /3\.8/i.test(currentCardText) &&
          !/\btts\b/i.test(currentCardText)
        ) {
          this.logStep(
            'model fallback',
            `"${targetModel}" not in list; keeping visible 3.8 model "${currentCardText}"`,
            'info',
          )
          expectedSubstringAfterPick = '3.8'
        }
      }

      // IMPORTANT (from video 00:46 -> 00:50): Clicking a model card in "Model selection" automatically
      // closes the Run Settings drawer! Re-open Run Settings now so we can read back the model card and set Thinking level.
      await this.ensureRunSettingsPanelOpen(page)

      // READ BACK the visible model card text from the Run Settings UI
      const readBackModel = await this.readVisibleModelCardText(page)
      const readNorm = normalizeModelStr(readBackModel)

      const modelMatched =
        Boolean(readNorm) &&
        !/\btts\b/i.test(readNorm) &&
        (readNorm.includes(expectedSubstringAfterPick) ||
          (expectedSubstringAfterPick.includes('3.8 flash') && /3\.8\s*flash/i.test(readNorm)) ||
          (expectedSubstringAfterPick.includes('3.8') && readNorm.includes('3.8') && pickResult.usedFallback))

      if (modelMatched) {
        verifiedModelText = readBackModel
        break
      }

      modelConfigError = `expected "${targetModel}" (or "${expectedSubstringAfterPick}"), read back "${readBackModel || 'empty'}"`
      this.logStep(`model retry ${modelAttempt}/2`, modelConfigError, 'warn')
      await this.dumpRunSettingsPanelDiagnostics(page, `model read-back mismatch: ${modelConfigError}`)

      if (modelAttempt >= 2) {
        throw new Error(`Studio model config failed: ${modelConfigError}`)
      }
    }

    // 2. Set Temperature = 0 (only if present; Gemini 3.8 Flash does not have a Temperature slider)
    try {
      const tempInput = await findFirstVisibleLocator(page, STUDIO_SELECTORS.temperatureInput, 600)
      if (tempInput) {
        await tempInput.click({ clickCount: 3 })
        await tempInput.fill('0')
        await tempInput.press('Enter')
      }
    } catch {
      /* ignore */
    }

    // 3. Set "Thinking level" dropdown to High & READ BACK visible value (retry once, dump panel HTML, then THROW)
    let verifiedThinkingText = ''
    let thinkingConfigError = ''

    for (let thinkAttempt = 1; thinkAttempt <= 2; thinkAttempt++) {
      await this.waitIfPausedOrThrowIfStopped(scope)
      thinkingConfigError = ''

      await this.ensureRunSettingsPanelOpen(page)

      // If there is a Thinking mode toggle switch that is currently unchecked, enable it first
      try {
        const thinkSwitch = await findFirstVisibleLocator(page, STUDIO_SELECTORS.thinkingToggle, 500)
        if (thinkSwitch) {
          const checked = await thinkSwitch.getAttribute('aria-checked')
          if (checked === 'false') {
            await thinkSwitch.click().catch(() => {})
            await new Promise((r) => setTimeout(r, 300))
          }
        }
      } catch {
        /* ignore */
      }

      let thinkSelect = await findFirstVisibleLocator(page, STUDIO_SELECTORS.thinkingLevelSelect, 1500)
      if (!thinkSelect) {
        const markedThink = await this.markRowDropdownByLabel(
          page,
          '^thinking(\\s+level|\\s+budget)?$',
          'thinking-level',
        )
        if (markedThink) {
          thinkSelect = page.locator('[data-cmt-row-select="thinking-level"]').first()
        }
      }

      if (!thinkSelect || (await thinkSelect.count()) === 0) {
        thinkingConfigError = 'Thinking level dropdown selector not found in Run settings panel'
        await this.dumpRunSettingsPanelDiagnostics(page, `${thinkingConfigError} (attempt ${thinkAttempt}/2)`)
      } else {
        const beforeThink = await this.readVisibleThinkingLevelText(page)
        if (!/\bhigh\b/i.test(beforeThink)) {
          await thinkSelect.scrollIntoViewIfNeeded().catch(() => {})
          await thinkSelect.click().catch(() => {})
          await new Promise((r) => setTimeout(r, 350))

          const highOpt = page
            .locator(
              'mat-option:has-text("High"), [role="option"]:has-text("High"), [role="menuitem"]:has-text("High"), .cdk-overlay-pane :text-is("High")',
            )
            .first()

          if ((await highOpt.count()) > 0 && (await highOpt.isVisible().catch(() => false))) {
            await highOpt.click().catch(() => {})
            await new Promise((r) => setTimeout(r, 350))
          } else {
            thinkingConfigError = '"High" option not found after opening Thinking level dropdown'
            await this.dumpRunSettingsPanelDiagnostics(page, `${thinkingConfigError} (attempt ${thinkAttempt}/2)`)
            await this.dismissOpenOverlayIfAny(page)
          }
        }

        const readBackThink = await this.readVisibleThinkingLevelText(page)
        if (/\bhigh\b/i.test(readBackThink)) {
          verifiedThinkingText = readBackThink
          break
        }
        if (!thinkingConfigError) {
          thinkingConfigError = `expected "High", read back "${readBackThink || 'empty'}"`
        }
        await this.dumpRunSettingsPanelDiagnostics(page, `thinking level read-back mismatch: ${thinkingConfigError}`)
      }

      this.logStep(`thinking retry ${thinkAttempt}/2`, thinkingConfigError, 'warn')
      if (thinkAttempt >= 2) {
        throw new Error(`Studio thinking level config failed: ${thinkingConfigError}`)
      }
    }

    // 4. Ensure Advanced Settings is expanded (in Gemini 3.8 Flash it is expanded by default; do not collapse it!)
    try {
      const mediaResAlreadyVisible = await page
        .evaluate(() => /media\s+resolution|output\s+length/i.test(document.body.innerText || ''))
        .catch(() => false)

      if (!mediaResAlreadyVisible) {
        const advBtn = await findFirstVisibleLocator(page, STUDIO_SELECTORS.advancedSettingsToggle, 1000)
        if (advBtn) {
          const expanded = await advBtn.getAttribute('aria-expanded')
          if (expanded === 'false') {
            await advBtn.click()
            await new Promise((r) => setTimeout(r, 300))
          }
        }
      }
    } catch {
      /* ignore */
    }

    // 5. Set Media Resolution = Low using row-scoped selector so it never hits Thinking level
    try {
      let resSelect = await findFirstVisibleLocator(page, STUDIO_SELECTORS.mediaResolutionSelect, 1200)
      if (!resSelect) {
        const markedRes = await this.markRowDropdownByLabel(page, '^media\\s+resolution$', 'media-resolution')
        if (markedRes) {
          resSelect = page.locator('[data-cmt-row-select="media-resolution"]').first()
        }
      }
      if (resSelect && (await resSelect.count()) > 0) {
        const currResText = ((await resSelect.innerText().catch(() => '')) || '').trim()
        if (!/\blow\b/i.test(currResText)) {
          await resSelect.scrollIntoViewIfNeeded().catch(() => {})
          await resSelect.click()
          await new Promise((r) => setTimeout(r, 300))
          const lowOpt = page
            .locator('mat-option:has-text("Low"), [role="option"]:has-text("Low"), [role="menuitem"]:has-text("Low")')
            .first()
          if ((await lowOpt.count()) > 0) {
            await lowOpt.click()
          } else {
            await this.dismissOpenOverlayIfAny(page)
          }
          await new Promise((r) => setTimeout(r, 250))
        }
      }
    } catch {
      /* ignore */
    }

    // 6. Set Output length (maxOutputTokens) & Safety Settings if needed
    try {
      const maxOutInput = await findFirstVisibleLocator(page, STUDIO_SELECTORS.maxOutputTokensInput, 1200)
      if (maxOutInput) {
        const currentMaxOut = await maxOutInput.inputValue().catch(() => '')
        const desiredMaxOut = String(config.maxOutputTokens || 65536)
        if (currentMaxOut.trim() !== desiredMaxOut) {
          await maxOutInput.click({ clickCount: 3 })
          await maxOutInput.fill(desiredMaxOut)
          await maxOutInput.press('Enter')
        }
      }
    } catch {
      /* ignore */
    }

    // Final read-back verification before closing Run Settings panel
    const finalModelReadBack = (await this.readVisibleModelCardText(page)) || verifiedModelText
    const finalThinkingReadBack = (await this.readVisibleThinkingLevelText(page)) || verifiedThinkingText
    if (!/\bhigh\b/i.test(finalThinkingReadBack)) {
      await this.dumpRunSettingsPanelDiagnostics(
        page,
        `final thinking read-back check failed: "${finalThinkingReadBack}"`,
      )
      throw new Error(`Studio thinking level config failed: expected "High", read back "${finalThinkingReadBack || 'empty'}"`)
    }

    // 7. Close the Run Settings panel (video 01:42-01:48) so the prompt box and Run button are uncovered
    await this.closeRunSettingsPanel(page)

    this.logStep(
      'model set',
      `model="${finalModelReadBack}" · thinking="${finalThinkingReadBack}" · mediaRes=Low`,
      'success',
    )
  }

  /**
   * Problem 1(a): Detect chips by anchoring on button[aria-label="Edit video options" i]
   * (and/or button[aria-label="Remove media" i]).
   * A chip = the nearest ancestor of that button that contains BOTH:
   *   - exactly one Edit button (button[aria-label="Edit video options" i] / video options)
   *   - and one Remove button (button[aria-label="Remove media" i]).
   * Tags each detected chip with `data-cmt-fallback-chip="true"` (keeping ms-* selectors as primary).
   * No filename or "N tokens" text dependency.
   */
  private async syncFallbackMediaChips(page: Page, _uploadedBasename?: string): Promise<void> {
    const primarySelector = STUDIO_SELECTORS.videoMediaChips.join(', ')
    await page
      .evaluate((primarySel) => {
        document
          .querySelectorAll('[data-cmt-fallback-chip]')
          .forEach((el) => el.removeAttribute('data-cmt-fallback-chip'))

        const primarySet = new Set<Element>(
          primarySel ? Array.from(document.querySelectorAll(primarySel)) : [],
        )

        const editBtnSel =
          'button[aria-label="Edit video options" i], button[aria-label*="Edit video options" i], button[aria-label*="Video options" i], button[aria-label*="Video settings" i], [role="button"][aria-label*="Edit video options" i]'
        const removeBtnSel =
          'button[aria-label="Remove media" i], button[aria-label*="Remove media" i], [role="button"][aria-label*="Remove media" i]'

        const editButtons = Array.from(document.body.querySelectorAll(editBtnSel))
        const foundChips: Element[] = []

        for (const editBtn of editButtons) {
          let curr: Element | null = editBtn.parentElement
          for (let depth = 0; depth < 8 && curr && curr !== document.body; depth++) {
            const editCount = curr.querySelectorAll(editBtnSel).length
            const removeCount = curr.querySelectorAll(removeBtnSel).length
            if (editCount === 1 && removeCount === 1) {
              if (!foundChips.includes(curr)) {
                foundChips.push(curr)
              }
              break
            }
            // If we climbed too high and now contain multiple Edit buttons, stop
            if (editCount > 1) {
              break
            }
            curr = curr.parentElement
          }
        }

        // Fallback if only Remove media + gear icon button exist inside the chip
        if (foundChips.length === 0) {
          const removeButtons = Array.from(document.body.querySelectorAll(removeBtnSel))
          for (const remBtn of removeButtons) {
            let curr: Element | null = remBtn.parentElement
            for (let depth = 0; depth < 8 && curr && curr !== document.body; depth++) {
              const removeCount = curr.querySelectorAll(removeBtnSel).length
              const allBtns = curr.querySelectorAll('button, [role="button"]').length
              if (removeCount === 1 && allBtns === 2) {
                if (!foundChips.includes(curr)) {
                  foundChips.push(curr)
                }
                break
              }
              if (removeCount > 1) break
              curr = curr.parentElement
            }
          }
        }

        for (const chip of foundChips) {
          const alreadyCovered = Array.from(primarySet).some(
            (p) => p === chip || p.contains(chip) || chip.contains(p),
          )
          if (!alreadyCovered) {
            chip.setAttribute('data-cmt-fallback-chip', 'true')
          }
        }
      }, primarySelector)
      .catch(() => {})
  }

  /**
   * Requirement 1: Dump detailed DOM diagnostics via this.logStep + save screenshot to DATA_DIR
   * before throwing when media chip count does not increase.
   */
  private async dumpChipAttachDiagnostics(
    page: Page,
    label: string,
    uploadedBasename: string,
  ): Promise<void> {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      const shotPath = path.join(DATA_DIR, `studio-attach-fail-${label}-${Date.now()}.png`)
      await page.screenshot({ path: shotPath, fullPage: true })
      this.logStep('diag screenshot', `Saved to ${shotPath}`, 'warn')
    } catch (shotErr) {
      this.logStep('diag screenshot err', (shotErr as Error).message, 'warn')
    }

    try {
      const diag = await page.evaluate((basename) => {
        const needle = (basename || '.mp4').toLowerCase()
        const all = Array.from(document.body.querySelectorAll('*'))
        const matching = all.filter((el) => {
          if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return false
          const t = ((el as HTMLElement).innerText || el.textContent || '').toLowerCase()
          return t.includes(needle)
        })

        // Smallest element whose text contains the uploaded file's basename (has no child also matching, or shortest outerHTML)
        const smallest =
          matching
            .filter((el) => !matching.some((child) => child !== el && el.contains(child)))
            .sort((a, b) => a.outerHTML.length - b.outerHTML.length)[0] || null

        const editBtns = Array.from(
          document.body.querySelectorAll(
            'button[aria-label*="Edit video" i], button[aria-label*="Remove media" i], button[aria-label*="video" i]',
          ),
        ).map(
          (b) =>
            `aria="${b.getAttribute('aria-label') || ''}" text="${(b.textContent || '').trim()}" parent=<${b.parentElement?.tagName.toLowerCase() || ''} class="${b.parentElement?.getAttribute('class') || ''}">`,
        )

        if (!smallest) {
          return {
            found: false,
            outerHtml: `No element found containing "${basename}". Video buttons: ${editBtns.join(' | ') || 'none'}. Body snippet: ${(document.body.innerText || '').slice(0, 500)}`,
            ancestors: 'none',
            buttons: editBtns.join(' ; ') || 'none',
          }
        }

        // (a) outerHTML (max 3000 chars) of the smallest element (plus its L2 parent if smallest is just a leaf text node)
        const smallestHtml = smallest.outerHTML.slice(0, 1500)
        const parent2Html =
          smallest.parentElement?.parentElement?.outerHTML.slice(0, 1500) ||
          smallest.parentElement?.outerHTML.slice(0, 1500) ||
          ''
        const combinedOuterHtml = (
          parent2Html && parent2Html !== smallestHtml
            ? `[smallest]: ${smallestHtml} | [ancestor-L2]: ${parent2Html}`
            : smallestHtml
        ).slice(0, 3000)

        // (b) ancestor tag names / classes / aria-labels up 4 levels
        const ancestorDescriptions: string[] = []
        let curr: Element | null = smallest
        for (let level = 0; level <= 4 && curr; level++) {
          const tag = curr.tagName.toLowerCase()
          const cls = (curr.getAttribute('class') || '').trim()
          const aria = (curr.getAttribute('aria-label') || '').trim()
          ancestorDescriptions.push(
            `L${level}: <${tag}${cls ? ` class="${cls}"` : ''}${aria ? ` aria-label="${aria}"` : ''}>`,
          )
          curr = curr.parentElement
        }

        // (c) all button aria-labels inside it (and inside up to 4 ancestor levels + page video buttons)
        const searchRoot =
          smallest.parentElement?.parentElement?.parentElement?.parentElement ||
          smallest.parentElement?.parentElement ||
          smallest
        const btnsInsideSmallest = Array.from(smallest.querySelectorAll('button, [role="button"]')).map(
          (b) =>
            `[in-smallest] aria="${b.getAttribute('aria-label') || ''}" tooltip="${b.getAttribute('mattooltip') || ''}" text="${(b.textContent || '').trim()}"`,
        )
        const btnsInsideChipRoot = Array.from(searchRoot.querySelectorAll('button, [role="button"]')).map(
          (b) =>
            `[in-L4] aria="${b.getAttribute('aria-label') || ''}" tooltip="${b.getAttribute('mattooltip') || ''}" text="${(b.textContent || '').trim()}"`,
        )

        return {
          found: true,
          outerHtml: combinedOuterHtml,
          ancestors: ancestorDescriptions.join(' -> '),
          buttons:
            [...btnsInsideSmallest, ...btnsInsideChipRoot, ...editBtns].join(' ; ') ||
            'no buttons found',
        }
      }, uploadedBasename)

      this.logStep(`diag (a) outerHTML [${label}]`, diag.outerHtml, 'warn')
      this.logStep(`diag (b) ancestors [${label}]`, diag.ancestors, 'warn')
      this.logStep(`diag (c) buttons [${label}]`, diag.buttons, 'warn')
      console.warn(`[Studio Attach Diag - ${label}] (a) outerHTML:`, diag.outerHtml)
      console.warn(`[Studio Attach Diag - ${label}] (b) ancestors:`, diag.ancestors)
      console.warn(`[Studio Attach Diag - ${label}] (c) buttons:`, diag.buttons)
    } catch (diagErr) {
      this.logStep('diag eval err', (diagErr as Error).message, 'warn')
    }
  }

  /**
   * Problem 1(c): Dump open Video Settings dialog / popover DOM + all inputs when start/end/FPS inputs are not found.
   */
  private async dumpVideoDialogDiagnostics(page: Page, label: string, reason: string): Promise<void> {
    try {
      const dump = await page.evaluate(() => {
        // Prioritize non-empty dialog / overlay panes that contain inputs or buttons (skipping empty tooltip panes)
        const candidates = Array.from(
          document.querySelectorAll(
            'mat-dialog-container, [role="dialog"], .cdk-overlay-pane, [class*="video-options" i], [class*="video-settings" i]',
          ),
        ).filter((el) => (el.innerHTML || '').trim().length > 0)

        const bestDialog =
          candidates.find((el) => el.querySelectorAll('input').length > 0) ||
          candidates[candidates.length - 1] ||
          null

        const dialogHtml = bestDialog
          ? bestDialog.outerHTML.slice(0, 3000)
          : 'No non-empty mat-dialog-container / [role="dialog"] / .cdk-overlay-pane found in DOM'

        const inputs = Array.from(document.querySelectorAll('input'))
          .map((inp) => {
            const fieldLabel =
              inp.closest('mat-form-field, label, div')?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 60) || ''
            return `<input type="${inp.type}" id="${inp.id || ''}" name="${inp.name || ''}" aria-label="${inp.getAttribute('aria-label') || ''}" placeholder="${inp.getAttribute('placeholder') || ''}" value="${inp.value}" label="${fieldLabel}">`
          })
          .join(' | ')
        return { dialogHtml, inputs }
      })
      this.logStep(`diag dialog HTML [${label}]`, `${reason} :: ${dump.dialogHtml}`, 'warn')
      this.logStep(`diag dialog inputs [${label}]`, dump.inputs || 'no inputs on page', 'warn')
      console.warn(`[Studio Dialog Diag - ${label}] ${reason} ::`, dump.dialogHtml)
      console.warn(`[Studio Dialog Diag - ${label}] inputs:`, dump.inputs)
    } catch (err) {
      this.logStep('diag dialog err', (err as Error).message, 'warn')
    }
  }

  /**
   * Tag the Start Time, End Time, FPS inputs and Save button inside the open "Video settings" dialog
   * (shown at 02:04-02:50 in the user's video: "Start Time (e.g., 1m10s)", "End Time (e.g., 2m30s)",
   * "FPS (frames per second)" with placeholder "Defaults to 1 FPS", and buttons "Cancel" / "Save").
   */
  private async tagVideoSettingsDialogControls(page: Page): Promise<void> {
    await page
      .evaluate(() => {
        document
          .querySelectorAll('[data-cmt-video-input]')
          .forEach((el) => el.removeAttribute('data-cmt-video-input'))
        document
          .querySelectorAll('[data-cmt-video-save]')
          .forEach((el) => el.removeAttribute('data-cmt-video-save'))

        const isVisible = (el: Element | null): el is HTMLElement => {
          if (!el) return false
          const h = el as HTMLElement
          const r = h.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && window.getComputedStyle(h).visibility !== 'hidden'
        }

        const dialogs = Array.from(
          document.querySelectorAll(
            'mat-dialog-container, [role="dialog"], .cdk-overlay-pane, [class*="video-settings" i], [class*="video-options" i]',
          ),
        ).filter((el) => isVisible(el) && el.querySelectorAll('input').length >= 2)

        const root = dialogs[dialogs.length - 1] || document.body
        const visibleInputs = Array.from(root.querySelectorAll('input')).filter(
          (inp) => isVisible(inp) && inp.type !== 'file' && inp.type !== 'checkbox' && inp.type !== 'hidden',
        )

        let taggedStart = false
        let taggedEnd = false
        let taggedFps = false

        for (const inp of visibleInputs) {
          const contextText = (
            (inp.getAttribute('aria-label') || '') +
            ' ' +
            (inp.getAttribute('placeholder') || '') +
            ' ' +
            (inp.closest('mat-form-field, label, .form-field, div')?.textContent || '')
          )
            .toLowerCase()
            .replace(/\s+/g, ' ')

          if (!taggedStart && /start\s*time|1m10s/i.test(contextText)) {
            inp.setAttribute('data-cmt-video-input', 'start')
            taggedStart = true
          } else if (!taggedEnd && /end\s*time|2m30s/i.test(contextText)) {
            inp.setAttribute('data-cmt-video-input', 'end')
            taggedEnd = true
          } else if (!taggedFps && /\bfps\b|frames\s+per\s+second|defaults\s+to\s+1\s+fps/i.test(contextText)) {
            inp.setAttribute('data-cmt-video-input', 'fps')
            taggedFps = true
          }
        }

        // Positional fallback if inside a dialog with exactly 3 visible inputs (Start Time, End Time, FPS)
        if (dialogs.length > 0 && visibleInputs.length === 3) {
          if (!taggedStart) visibleInputs[0].setAttribute('data-cmt-video-input', 'start')
          if (!taggedEnd) visibleInputs[1].setAttribute('data-cmt-video-input', 'end')
          if (!taggedFps) visibleInputs[2].setAttribute('data-cmt-video-input', 'fps')
        }

        // Tag the Save button (never Cancel or Close)
        const btns = Array.from(root.querySelectorAll('button, [role="button"]')).filter(isVisible)
        for (const b of btns) {
          const txt = (b.innerText || b.textContent || '').trim()
          if (/^save$/i.test(txt) || /^apply$/i.test(txt) || /^done$/i.test(txt)) {
            b.setAttribute('data-cmt-video-save', 'true')
            break
          }
        }
      })
      .catch(() => {})
  }

  /**
   * FIX 1: Attach a YouTube link or Drive file or local file as a video asset in the prompt,
   * verify media chip count increased AND finished "Loading..." (gear icon visible),
   * configure Start Time (e.g. 0s), End Time (e.g. 5m), and FPS = 24 via the Video Settings dialog,
   * READ BACK all three values to confirm they stuck, and click Save.
   */
  private async attachVideoAndConfigureRange(
    page: Page,
    params: {
      label: 'short' | 'movie'
      youtubeUrl?: string | null
      driveFileName?: string | null
      localFilePath?: string | null
      startSec: number
      endSec: number
      fps: number
      scope?: { scanId?: string | null; username?: string | null }
    },
  ) {
    const { label, youtubeUrl, driveFileName, localFilePath, startSec, endSec, fps, scope } = params
    await this.waitIfPausedOrThrowIfStopped(scope)

    // Ensure Run Settings panel is closed before interacting with the prompt box / + button / chips
    await this.closeRunSettingsPanel(page)

    const uploadedBasename =
      driveFileName ||
      (localFilePath ? path.basename(localFilePath) : '') ||
      (youtubeUrl ? 'youtube' : '')

    // Combined locator: STUDIO_SELECTORS.videoMediaChips + fallback chip locator ([data-cmt-fallback-chip="true"])
    const combinedChipSelector = [
      ...STUDIO_SELECTORS.videoMediaChips,
      '[data-cmt-fallback-chip="true"]',
    ].join(', ')
    const chipsLocator = page.locator(combinedChipSelector)

    await this.syncFallbackMediaChips(page)
    const chipsBefore = await chipsLocator.count()

    if (youtubeUrl) {
      // Option 1: Try Insert (+) -> YouTube URL modal, or direct paste into prompt input
      let attachedViaMenu = false
      const insertBtn = await findFirstVisibleLocator(page, STUDIO_SELECTORS.insertMediaButton, 2500)
      if (insertBtn) {
        await insertBtn.click()
        await new Promise((r) => setTimeout(r, 350))
        const ytOpt = await findFirstVisibleLocator(page, STUDIO_SELECTORS.insertMenuYoutubeOption, 1500)
        if (ytOpt) {
          await ytOpt.click()
          await new Promise((r) => setTimeout(r, 400))
          const ytInput = await findFirstVisibleLocator(page, STUDIO_SELECTORS.youtubeModalInput, 2000)
          if (ytInput) {
            await ytInput.fill(youtubeUrl)
            const confirmBtn = await findFirstVisibleLocator(page, STUDIO_SELECTORS.youtubeModalConfirm, 1500)
            if (confirmBtn) await confirmBtn.click()
            else await ytInput.press('Enter')
            attachedViaMenu = true
          }
        } else {
          await page.keyboard.press('Escape')
        }
      }

      if (!attachedViaMenu) {
        // Fallback: paste the YouTube URL directly into the prompt textarea (AI Studio auto-converts YouTube URLs to video chips)
        const promptInput = await findFirstVisibleLocator(page, STUDIO_SELECTORS.promptInput, 3000)
        if (promptInput) {
          await promptInput.click()
          await page.evaluate((url) => {
            const dt = new DataTransfer()
            dt.setData('text/plain', url)
            document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }))
          }, youtubeUrl)
          await new Promise((r) => setTimeout(r, 1000))
        }
      }
    } else if (driveFileName) {
      // Attach from Google Drive picker by file name (Insert -> Drive -> search driveFileName -> Select)
      let attachedFromDrive = false
      const insertBtn = await findFirstVisibleLocator(page, STUDIO_SELECTORS.insertMediaButton, 3000)
      if (insertBtn) {
        await insertBtn.click()
        await new Promise((r) => setTimeout(r, 400))
        const driveOpt = await findFirstVisibleLocator(page, STUDIO_SELECTORS.insertMenuDriveOption, 2500)
        if (driveOpt) {
          await driveOpt.click()
          await new Promise((r) => setTimeout(r, 1500))

          // Locate the Google Drive Picker iframe
          const frames = page.frames()
          const pickerFrame = frames.find(
            (f) => f.url().includes('docs.google.com/picker') || f.url().includes('drive.google.com'),
          )
          if (pickerFrame) {
            const searchBox = await findFirstVisibleLocator(
              pickerFrame,
              STUDIO_SELECTORS.drivePickerSearchInput,
              5000,
            )
            if (searchBox) {
              await searchBox.fill(driveFileName)
              await searchBox.press('Enter')
              await new Promise((r) => setTimeout(r, 2000))
            }
            // Click the matching file row inside the picker
            const row = pickerFrame.locator(`text="${driveFileName}"`).first()
            if ((await row.count()) > 0) {
              await row.click()
              await new Promise((r) => setTimeout(r, 400))
              const selectBtn = await findFirstVisibleLocator(
                pickerFrame,
                STUDIO_SELECTORS.drivePickerSelectButton,
                3000,
              )
              if (selectBtn) {
                await selectBtn.click()
                attachedFromDrive = true
              } else {
                await row.dblclick()
                attachedFromDrive = true
              }
            }
          }
        } else {
          await page.keyboard.press('Escape')
        }
      }

      // Fallback if Drive picker iframe couldn't be interacted with and local file exists
      if (!attachedFromDrive && localFilePath && fs.existsSync(localFilePath)) {
        await this.uploadLocalFileToStudio(page, localFilePath)
      }
    } else if (localFilePath && fs.existsSync(localFilePath)) {
      await this.uploadLocalFileToStudio(page, localFilePath)
    } else {
      throw new Error(`No media source available to attach ${label} video in Studio`)
    }

    // FIX 1a: Wait for the new video chip to appear AND finish "Loading..." (so its gear button "Edit video options" is present)
    const waitDeadline = Date.now() + 90_000
    let chipCount = chipsBefore
    while (Date.now() < waitDeadline) {
      await this.waitIfPausedOrThrowIfStopped(scope)
      await this.syncFallbackMediaChips(page)
      chipCount = await chipsLocator.count()
      if (chipCount > chipsBefore) {
        const candidateChip = chipsLocator.nth(chipsBefore)
        const chipText = ((await candidateChip.innerText().catch(() => '')) || '').trim()
        const gearBtnCount = await candidateChip
          .locator('button[aria-label*="Edit video options" i], button[aria-label*="Video options" i], button[aria-label*="Video settings" i]')
          .count()
          .catch(() => 0)
        // As shown in video 01:54 -> 01:56, while "Loading..." is displayed the gear icon is not ready yet
        if (gearBtnCount > 0 || !/\bloading\b/i.test(chipText)) {
          break
        }
      }
      await new Promise((r) => setTimeout(r, 500))
    }

    if (chipCount <= chipsBefore) {
      await this.dumpChipAttachDiagnostics(page, label, uploadedBasename)
      throw new Error(
        `Studio video attach failed for ${label}: media chip count did not increase within 90s (before=${chipsBefore}, after=${chipCount})`,
      )
    }

    // Problem 1(d): Target the chip we just added at index chipsBefore (short = 0, movie = 1)
    const targetChipIndex = chipsBefore

    const targetChip = chipsLocator.nth(targetChipIndex)
    if ((await targetChip.count()) === 0) {
      throw new Error(`Studio clip config failed: target media chip #${targetChipIndex} for ${label} not found`)
    }

    // Requirement 4: Keep the existing "movie chip must not resolve to index 0" check working with the new locator
    if (label === 'movie' && targetChipIndex === 0 && chipsBefore >= 1) {
      throw new Error(`Studio clip config failed: movie chip resolved to index 0 (short video chip)`)
    }

    // FIX 1c: Open Video Settings on targetChip via button[aria-label="Edit video options"],
    // set Start Time (e.g. 0s), End Time (e.g. 5m), and FPS = 24, and READ BACK all three values.
    // Retry the dialog once if any input is missing or any value did not stick, then THROW.
    const startStr = this.formatClockForStudioInput(startSec)
    const endStr = this.formatClockForStudioInput(endSec)
    let lastConfigError = ''

    for (let dialogAttempt = 1; dialogAttempt <= 2; dialogAttempt++) {
      await this.waitIfPausedOrThrowIfStopped(scope)
      lastConfigError = ''

      await targetChip.scrollIntoViewIfNeeded().catch(() => {})
      await targetChip.hover().catch(() => {})
      await new Promise((r) => setTimeout(r, 250))

      // Prefer explicit video settings (gear: button[aria-label="Edit video options"]) inside the chip; NEVER click Remove media
      let openedDialog = false
      for (const btnSel of STUDIO_SELECTORS.videoChipSettingsButton) {
        const btn = targetChip.locator(btnSel).first()
        if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
          await btn.click()
          openedDialog = true
          break
        }
      }
      if (!openedDialog) {
        // Fallback: find the first button inside targetChip that is NOT "Remove media" / close / delete
        const chipButtons = targetChip.locator('button, [role="button"]')
        const btnCount = await chipButtons.count()
        for (let bIdx = 0; bIdx < btnCount; bIdx++) {
          const btn = chipButtons.nth(bIdx)
          const btnMeta = (
            ((await btn.getAttribute('aria-label').catch(() => '')) || '') +
            ' ' +
            ((await btn.getAttribute('mattooltip').catch(() => '')) || '') +
            ' ' +
            ((await btn.getAttribute('title').catch(() => '')) || '') +
            ' ' +
            (await btn.innerText().catch(() => ''))
          )
            .trim()
            .toLowerCase()
          if (!/\b(close|cancel|clear|remove|delete)\b|^×$|^x$/i.test(btnMeta)) {
            await btn.click()
            openedDialog = true
            break
          }
        }
      }
      await new Promise((r) => setTimeout(r, 650))

      // Tag the Start Time, End Time, FPS inputs and Save button inside the open Video settings dialog
      await this.tagVideoSettingsDialogControls(page)

      const startInput = await findFirstVisibleLocator(page, STUDIO_SELECTORS.videoStartTimeInput, 2500)
      const endInput = await findFirstVisibleLocator(page, STUDIO_SELECTORS.videoEndTimeInput, 2500)
      const fpsInput = await findFirstVisibleLocator(page, STUDIO_SELECTORS.videoFpsInput, 2500)

      if (!startInput) {
        lastConfigError = `start time input not found for ${label}`
        await this.dumpVideoDialogDiagnostics(page, label, lastConfigError)
      } else if (!endInput) {
        lastConfigError = `end time input not found for ${label}`
        await this.dumpVideoDialogDiagnostics(page, label, lastConfigError)
      } else if (!fpsInput) {
        lastConfigError = `fps input not found for ${label}`
        await this.dumpVideoDialogDiagnostics(page, label, lastConfigError)
      } else {
        await startInput.click({ clickCount: 3 })
        await startInput.fill(startStr)
        await startInput.dispatchEvent('input').catch(() => {})
        await startInput.dispatchEvent('change').catch(() => {})

        await endInput.click({ clickCount: 3 })
        await endInput.fill(endStr)
        await endInput.dispatchEvent('input').catch(() => {})
        await endInput.dispatchEvent('change').catch(() => {})

        await fpsInput.click({ clickCount: 3 })
        await fpsInput.fill(String(fps))
        await fpsInput.dispatchEvent('input').catch(() => {})
        await fpsInput.dispatchEvent('change').catch(() => {})
        await fpsInput.press('Tab').catch(() => {})
        await new Promise((r) => setTimeout(r, 250))

        // Read back the three values from the dialog before clicking Save
        const readStartRaw = await startInput.inputValue().catch(() => '')
        const readEndRaw = await endInput.inputValue().catch(() => '')
        const readFpsRaw = await fpsInput.inputValue().catch(() => '')

        const readStartSec = this.parseStudioClockToSec(readStartRaw)
        const readEndSec = this.parseStudioClockToSec(readEndRaw)
        const readFps = Number(readFpsRaw.trim())

        if (!Number.isFinite(readFps) || Math.abs(readFps - fps) > 0.01) {
          lastConfigError = `fps (expected ${fps}, read back "${readFpsRaw}") on ${label}`
        } else if (readStartSec === null || Math.abs(readStartSec - Math.floor(startSec)) > 1) {
          lastConfigError = `start time (expected ${startStr} [${Math.floor(startSec)}s], read back "${readStartRaw}") on ${label}`
        } else if (readEndSec === null || Math.abs(readEndSec - Math.floor(endSec)) > 1) {
          lastConfigError = `end time (expected ${endStr} [${Math.floor(endSec)}s], read back "${readEndRaw}") on ${label}`
        }
        if (lastConfigError) {
          await this.dumpVideoDialogDiagnostics(page, label, lastConfigError)
        }
      }

      // Click the "Save" button at the bottom-right of the Video settings dialog (video 02:49)
      await this.tagVideoSettingsDialogControls(page)
      const saveBtn = await findFirstVisibleLocator(page, STUDIO_SELECTORS.videoSettingsSaveButton, 1500)
      if (saveBtn) {
        await saveBtn.click().catch(() => {})
      } else {
        await page.keyboard.press('Enter').catch(() => {})
      }
      await new Promise((r) => setTimeout(r, 600))

      if (!lastConfigError) {
        break
      }

      this.logStep(
        `${label} clip config retry ${dialogAttempt}/2`,
        `Studio clip config failed: ${lastConfigError}`,
        'warn',
      )
      if (dialogAttempt >= 2) {
        throw new Error(`Studio clip config failed: ${lastConfigError}`)
      }
    }

    this.logStep(
      `${label} attached`,
      `chip #${targetChipIndex} · ${startStr}–${endStr} @ ${fps} FPS (verified)`,
      'success',
    )
  }

  private async uploadLocalFileToStudio(page: Page, filePath: string) {
    const fileInput = page.locator('input[type="file"]').first()
    if ((await fileInput.count()) > 0) {
      await fileInput.setInputFiles(filePath)
      return
    }
    const insertBtn = await findFirstVisibleLocator(page, STUDIO_SELECTORS.insertMediaButton, 2500)
    if (insertBtn) {
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null),
        (async () => {
          await insertBtn.click()
          await new Promise((r) => setTimeout(r, 350))
          const upOpt = await findFirstVisibleLocator(page, STUDIO_SELECTORS.insertMenuUploadFileOption, 2000)
          if (upOpt) await upOpt.click()
        })(),
      ])
      if (fileChooser) {
        await fileChooser.setFiles(filePath)
      }
    }
  }

  /**
   * Read AI Studio's total token counter from the DOM.
   * As shown in the user's video (02:56-03:04), the total token count is displayed in the top header bar
   * next to "Untitled prompt" (e.g. "520,801 tokens") AND each media chip also displays its own token count.
   * We inspect both the top header and all chip token counts so we never return only a single small chip's
   * token count when two videos are attached.
   */
  public async readStudioTokenCount(page: Page): Promise<number | null> {
    try {
      const count = await page.evaluate(() => {
        const isVisible = (el: Element | null): el is HTMLElement => {
          if (!el) return false
          const h = el as HTMLElement
          const r = h.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && window.getComputedStyle(h).visibility !== 'hidden'
        }

        // 1. Check top header bar elements (rect.top < 115) for total prompt tokens (next to "Untitled prompt")
        let headerTokens = 0
        const topNodes = Array.from(document.body.querySelectorAll('span, div, button, p'))
        for (const node of topNodes) {
          if (!isVisible(node)) continue
          const r = node.getBoundingClientRect()
          if (r.top < 0 || r.top > 115 || r.height > 60) continue
          const txt = ((node as HTMLElement).innerText || node.textContent || '').trim()
          if (txt.length > 80) continue
          const m = txt.match(/([\d,]+)\s*(?:\/\s*[\d,]+\s*)?tokens?\b/i)
          if (m) {
            const val = parseInt(m[1].replace(/,/g, ''), 10)
            if (Number.isFinite(val) && val > headerTokens) {
              headerTokens = val
            }
          }
        }

        // 2. Sum token counts across all attached media chips (each chip has one Edit video options button)
        let chipTokensSum = 0
        const editBtns = Array.from(
          document.body.querySelectorAll(
            'button[aria-label="Edit video options" i], button[aria-label*="Edit video options" i], button[aria-label*="Video options" i]',
          ),
        )
        const visitedChips = new Set<Element>()
        for (const btn of editBtns) {
          let curr: Element | null = btn.parentElement
          for (let d = 0; d < 6 && curr && curr !== document.body; d++) {
            const txt = ((curr as HTMLElement).innerText || curr.textContent || '').trim()
            const m = txt.match(/([\d,]+)\s*tokens?\b/i)
            if (m && curr.querySelectorAll('button[aria-label*="Edit video" i]').length === 1) {
              if (!visitedChips.has(curr)) {
                visitedChips.add(curr)
                const val = parseInt(m[1].replace(/,/g, ''), 10)
                if (Number.isFinite(val) && val > 0) {
                  chipTokensSum += val
                }
              }
              break
            }
            curr = curr.parentElement
          }
        }

        // 3. Also scan all token occurrences in bodyText and take the maximum
        const bodyText = document.body.innerText || ''
        let maxBodyTokens = 0
        const allMatches = bodyText.matchAll(/([\d,]{3,})\s*(?:\/\s*[\d,]+\s*)?tokens?\b/gi)
        for (const m of allMatches) {
          const val = parseInt(m[1].replace(/,/g, ''), 10)
          if (Number.isFinite(val) && val > maxBodyTokens) {
            maxBodyTokens = val
          }
        }

        const best = Math.max(headerTokens, chipTokensSum, maxBodyTokens)
        return best > 0 ? best : null
      })
      if (count !== null) {
        this.tokenCount = count
        this.logStep(`tokens ${Math.round(count / 1000)}K`, `${count.toLocaleString()} tokens`)
      }
      return count
    } catch {
      return null
    }
  }

  /**
   * Copy ONLY the final model response text from the latest turn,
   * explicitly stripping any thinking / thought blocks (`ms-thought-chunk`, etc.).
   */
  private async extractFinalAnswerWithoutThoughts(page: Page): Promise<string> {
    const thoughtSelectors = STUDIO_SELECTORS.thoughtContainersToExclude
    const turnSelectors = STUDIO_SELECTORS.modelTurnContainers

    const extracted = await page.evaluate(
      ({ turnSels, thoughtSels }) => {
        let turns: Element[] = []
        for (const sel of turnSels) {
          const found = Array.from(document.querySelectorAll(sel))
          if (found.length > 0) {
            turns = found
            break
          }
        }
        const lastTurn = turns[turns.length - 1]
        if (!lastTurn) return ''

        // Clone the DOM node so we can safely remove all thought/thinking elements before reading innerText
        const clone = lastTurn.cloneNode(true) as HTMLElement
        for (const tSel of thoughtSels) {
          clone.querySelectorAll(tSel).forEach((el) => el.remove())
        }
        return (clone.innerText || clone.textContent || '').trim()
      },
      {
        turnSels: [...turnSelectors],
        thoughtSels: [...thoughtSelectors],
      },
    )

    return extracted
  }

  /**
   * Execute a single (shortPart, movieBlock) Studio job:
   * a. Open a NEW chat on aistudio.google.com
   * b. Select model, temperature=0, thinking=High, maxOutputTokens, safety=OFF, mediaRes=Low
   * c. Attach Video 1 (short part) & Video 2 (movie_360p), set start/end times + FPS=24 (verified read-back)
   * d. Paste prompt text and check token counter BEFORE pressing Run:
   *    - If > maxInputTokens (1_048_576 - maxOutputTokens - 5_000, or user override), signal shrink_needed
   *    - Never run the shrink check after pressing Run (during generation the counter can include output tokens)
   *    - Keep the implausibly low token counter check (minimum 500 tokens/sec of video)
   * e. Press Run -> wait up to 15m -> require Stop hidden + Run enabled + 6s stable answer
   * f. Copy final answer text only (no thoughts) -> calibrate offset mode -> parseChunkMatches
   * g. Recycle Playwright page in same persistent context after every N finished window jobs (default 5)
   */
  public async runWindowJob(params: {
    username: string
    scanId: string
    jobLabel: string
    modelName: string
    maxOutputTokens: number
    maxInputTokens?: number | null
    pageRecycleInterval?: number
    shortYoutubeUrl?: string | null
    shortDriveFileName?: string | null
    shortLocalPath?: string | null
    shortStartSec: number
    shortEndSec: number
    movieDriveFileName?: string | null
    movieLocalPath?: string | null
    movieStartSec: number
    movieEndSec: number
    sanitized?: boolean
    onLog?: (level: 'info' | 'warn' | 'error' | 'success', msg: string) => void
  }): Promise<
    | { status: 'shrink_needed'; tokenCount: number; maxInputTokens: number }
    | {
        status: 'success'
        rawText: string
        tokenCount: number
        isRealTokenCount: boolean
        matches: ChunkMatch[]
        calibratedOffsetMode: 'relative' | 'absolute'
      }
  > {
    const {
      username,
      scanId,
      jobLabel,
      modelName,
      maxOutputTokens,
      shortYoutubeUrl,
      shortDriveFileName,
      shortLocalPath,
      shortStartSec,
      shortEndSec,
      movieDriveFileName,
      movieLocalPath,
      movieStartSec,
      movieEndSec,
      sanitized = false,
      onLog,
    } = params

    const userCfg = await loadStudioUserConfig(username)
    const effectiveMaxInputTokens = computeEffectiveMaxInputTokens(
      maxOutputTokens,
      params.maxInputTokens !== undefined ? params.maxInputTokens : userCfg.studioMaxInputTokens,
    )
    const effectiveRecycleInterval =
      params.pageRecycleInterval ?? userCfg.studioPageRecycleInterval ?? 5

    const scope = { scanId, username }
    this.setJobContext(scanId, jobLabel, username)

    const totalVideoSec = Math.max(1, (shortEndSec - shortStartSec) + (movieEndSec - movieStartSec))
    // Item 3: KEEP the "implausibly low token counter" check (minimum 500 tokens/sec of video).
    // Real rate for 24 fps is about 1940 tokens/sec (930K for 480 s).
    const minPlausible24FpsTokens = Math.round(totalVideoSec * 500)

    const MAX_ATTEMPTS = 3
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.waitIfPausedOrThrowIfStopped(scope)
      const page = await this.ensurePage(username)

      try {
        // (a) Open a NEW chat on aistudio.google.com
        this.logStep('opening new chat', `${jobLabel} (attempt ${attempt}/${MAX_ATTEMPTS})`)
        await page.goto(STUDIO_URLS.newChat, {
          waitUntil: 'domcontentloaded',
          timeout: 45_000,
        })
        await new Promise((r) => setTimeout(r, 2500))
        await this.dismissAnyOnboardingModals(page)

        if (page.url().includes('accounts.google.com')) {
          throw new Error(
            'Google session logged out or requires verification. Open "Gemini Studio Live" -> Login Assist or paste fresh cookies in Settings.',
          )
        }

        // (b) Configure model, temperature 0, thinking High, max output tokens, safety OFF
        await this.configureRunSettings(page, { modelName, maxOutputTokens }, scope)

        // (c) Attach Video 1 = short part & Video 2 = movie_360p, set start/end & 24 FPS
        await this.attachVideoAndConfigureRange(page, {
          label: 'short',
          youtubeUrl: shortYoutubeUrl,
          driveFileName: shortDriveFileName,
          localFilePath: shortLocalPath,
          startSec: shortStartSec,
          endSec: shortEndSec,
          fps: 24,
          scope,
        })

        await this.attachVideoAndConfigureRange(page, {
          label: 'movie',
          driveFileName: movieDriveFileName,
          localFilePath: movieLocalPath,
          startSec: movieStartSec,
          endSec: movieEndSec,
          fps: 24,
          scope,
        })

        // (d) Paste the chunk prompt text BEFORE reading the input token counter and BEFORE pressing Run
        const promptText = buildStudioChunkPrompt({
          movieWindowSec: movieEndSec - movieStartSec,
          shortPartSec: shortEndSec - shortStartSec,
          sanitized,
        })

        const promptInput = await findFirstVisibleLocator(page, STUDIO_SELECTORS.promptInput, 5000)
        if (!promptInput) {
          throw new Error('Could not find prompt input textarea on AI Studio page')
        }
        await promptInput.click()
        await promptInput.fill(promptText)

        // Wait up to 60 s for AI Studio to finish counting tokens for both attached videos + pasted prompt text:
        // poll every 1 s, log each reading in the step log, and accept the value only when
        // it is >= minPlausible24FpsTokens AND unchanged for 3 consecutive reads (counter settled).
        let tokens: number | null = null
        let settledTokens: number | null = null
        let lastReadTokens: number | null = null
        let consecutiveSameReads = 0
        let pollCount = 0
        const tokenWaitDeadline = Date.now() + 60_000

        while (Date.now() < tokenWaitDeadline) {
          await new Promise((r) => setTimeout(r, 1000))
          pollCount += 1
          const readVal = await this.readStudioTokenCount(page)
          if (readVal !== null) {
            tokens = readVal
            if (readVal >= minPlausible24FpsTokens) {
              if (readVal === lastReadTokens) {
                consecutiveSameReads += 1
              } else {
                lastReadTokens = readVal
                consecutiveSameReads = 1
              }
            } else {
              lastReadTokens = readVal
              consecutiveSameReads = 0
            }
            this.logStep(
              `token poll ${pollCount}s`,
              `${readVal.toLocaleString()} tokens (min ${minPlausible24FpsTokens.toLocaleString()}, settled ${consecutiveSameReads}/3)`,
            )
            if (readVal >= minPlausible24FpsTokens && consecutiveSameReads >= 3) {
              settledTokens = readVal
              tokens = settledTokens
              break
            }
          } else {
            lastReadTokens = null
            consecutiveSameReads = 0
            this.logStep(`token poll ${pollCount}s`, 'null (counter not readable)')
          }
        }

        if (tokens === null) {
          const warnMsg = `Token counter was never readable (null) after 60s for ${jobLabel} — continuing with fallback estimate`
          this.logStep('token counter warning', warnMsg, 'warn')
          onLog?.('warn', warnMsg)
        } else if (settledTokens === null) {
          throw new Error(
            `FPS/range not applied: token counter (${tokens}) is implausibly low for ${totalVideoSec.toFixed(0)}s at 24 FPS (expected >= ${minPlausible24FpsTokens})`,
          )
        }

        // Item 1 & Item 2: Do the token-limit shrink check BEFORE pressing Run
        // (after both videos are attached and the prompt text is pasted).
        // Never run the shrink check after the run started!
        if (tokens !== null && tokens > effectiveMaxInputTokens) {
          const msg = `Studio token counter is ${(tokens / 1000).toFixed(0)}K (> ${(effectiveMaxInputTokens / 1000).toFixed(0)}K limit [${effectiveMaxInputTokens.toLocaleString()}]) for ${jobLabel} — shrinking movie block and retrying`
          this.logStep('shrinking block', msg, 'warn')
          onLog?.('warn', msg)
          return {
            status: 'shrink_needed',
            tokenCount: tokens,
            maxInputTokens: effectiveMaxInputTokens,
          }
        }

        // (e) Press Run
        const runBtn = await findFirstVisibleLocator(page, STUDIO_SELECTORS.runButton, 4000)
        if (runBtn) {
          await runBtn.click()
        } else {
          await promptInput.press('Control+Enter')
        }

        // FIX 3: Poll every 1 s up to 15-min timeout.
        // Declare answer finished ONLY when ALL are true:
        // - Stop button is not visible
        // - Run button is visible and enabled
        // - Extracted answer text is non-empty and UNCHANGED for 6 consecutive seconds
        const runStarted = Date.now()
        const TIMEOUT_MS = 15 * 60_000
        let rawAnswer = ''
        let lastCandidateText = ''
        let stableSeconds = 0

        while (Date.now() - runStarted < TIMEOUT_MS) {
          await this.waitIfPausedOrThrowIfStopped(scope)
          const elapsed = Math.floor((Date.now() - runStarted) / 1000)
          const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
          const ss = String(elapsed % 60).padStart(2, '0')
          this.logStep(`running ${mm}:${ss}`, jobLabel)

          // FIX 3b: Stricter error/quota/alert banner detection (real alert/banner containers + specific phrases only)
          const errBannerText = await page.evaluate((sels) => {
            const strictRegex =
              /(quota\s+exceeded|resource[_\s]+exhausted|rate\s+limit|try\s+again\s+later|prohibited_content|blocked\s+due\s+to\s+safety)/i
            for (const s of sels) {
              const nodes = Array.from(document.querySelectorAll(s))
              for (const node of nodes) {
                const el = node as HTMLElement
                if (!el || !el.innerText) continue
                const visible = el.offsetParent !== null || el.getClientRects().length > 0
                if (!visible) continue
                const t = el.innerText.trim()
                if (strictRegex.test(t)) {
                  return t
                }
              }
            }
            return null
          }, [...STUDIO_SELECTORS.errorBanners])

          if (errBannerText) {
            this.logStep('error banner', errBannerText.slice(0, 180), 'warn')
            onLog?.('warn', `Matched AI Studio error banner on ${jobLabel}: "${errBannerText.slice(0, 200)}"`)
            if (/(prohibited_content|blocked\s+due\s+to\s+safety)/i.test(errBannerText) && !sanitized) {
              onLog?.(
                'warn',
                `Studio flagged content policy on ${jobLabel} — retrying once with sanitized neutral prompt`,
              )
              return this.runWindowJob({ ...params, sanitized: true })
            }
            throw new Error(`AI Studio banner error: ${errBannerText.slice(0, 180)}`)
          }

          if (elapsed >= 3) {
            const stopLoc = await findFirstVisibleLocator(page, STUDIO_SELECTORS.stopButton, 100)
            const stopNotVisible = !stopLoc

            const runLoc = await findFirstVisibleLocator(page, STUDIO_SELECTORS.runButton, 100)
            const runVisibleAndEnabled = Boolean(
              runLoc && (await runLoc.isEnabled().catch(() => false)),
            )

            const candidateText = await this.extractFinalAnswerWithoutThoughts(page)
            if (stopNotVisible && runVisibleAndEnabled && candidateText.length > 0) {
              if (candidateText === lastCandidateText) {
                stableSeconds += 1
              } else {
                lastCandidateText = candidateText
                stableSeconds = 1
              }

              if (stableSeconds >= 6) {
                rawAnswer = candidateText
                break
              }
            } else {
              if (candidateText.length > 0) {
                lastCandidateText = candidateText
              }
              stableSeconds = 0
            }
          }

          await new Promise((r) => setTimeout(r, 1000))
        }

        if (!rawAnswer) {
          throw new Error(`Timed out waiting for stable answer from AI Studio for ${jobLabel}`)
        }

        this.logStep('answer copied', `${rawAnswer.length} chars extracted (6s stable, thoughts excluded)`, 'success')

        // (f) Calibrate offset mode (relative 0:00 vs absolute startSec) and parse via parseChunkMatches!
        const calibrated = await this.calibrateAndParseMatches({
          username,
          rawText: rawAnswer,
          shortStartSec,
          shortEndSec,
          movieStartSec,
          movieEndSec,
          modelName,
          onLog,
        })

        // Item 5: Page recycling after every N finished window jobs (success or failed)
        await this.recordFinishedWindowJobAndMaybeRecyclePage(
          username,
          effectiveRecycleInterval,
          onLog,
        )

        // Item 4: Token-report fallback — when Studio counter is not readable, estimate with 1940 tokens/sec (calibrated: 930K / 480 s).
        // The real counter always wins when readable.
        const fallbackTokens24Fps = Math.round(totalVideoSec * 1940)
        return {
          status: 'success',
          rawText: rawAnswer,
          tokenCount: tokens || fallbackTokens24Fps,
          isRealTokenCount: tokens !== null,
          matches: calibrated.matches,
          calibratedOffsetMode: calibrated.offsetMode,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const isPolicy = /(prohibited_content|blocked\s+due\s+to\s+safety)/i.test(msg)
        if (isPolicy && sanitized) {
          await this.recordFinishedWindowJobAndMaybeRecyclePage(
            username,
            effectiveRecycleInterval,
            onLog,
          )
          throw new Error(`POLICY_BLOCKED: ${msg}`)
        }
        const backoffSec = attempt * 15
        this.logStep(
          `retry ${attempt}/${MAX_ATTEMPTS}`,
          `${msg.slice(0, 100)} — waiting ${backoffSec}s`,
          'warn',
        )
        onLog?.('warn', `Studio job ${jobLabel} attempt ${attempt}/${MAX_ATTEMPTS} error: ${msg} — retrying in ${backoffSec}s...`)
        if (attempt >= MAX_ATTEMPTS) {
          // Item 5: Count failed window job toward page recycle interval too
          await this.recordFinishedWindowJobAndMaybeRecyclePage(
            username,
            effectiveRecycleInterval,
            onLog,
          )
          throw err
        }
        await new Promise((r) => setTimeout(r, backoffSec * 1000))
      }
    }

    throw new Error(`Studio job ${jobLabel} failed after ${MAX_ATTEMPTS} attempts`)
  }

  /**
   * Requirement 5(g) Calibration:
   * When start/end offset is set on a video in Studio, check whether the model's timestamps
   * in the answer are 0:00-based (relative to clip start) or start-offset-based (absolute to full video),
   * and apply the right offset so parseChunkMatches gets accurate timestamps.
   */
  private async calibrateAndParseMatches(params: {
    username: string
    rawText: string
    shortStartSec: number
    shortEndSec: number
    movieStartSec: number
    movieEndSec: number
    modelName: string
    onLog?: (level: 'info' | 'warn' | 'error' | 'success', msg: string) => void
  }): Promise<{ matches: ChunkMatch[]; offsetMode: 'relative' | 'absolute' }> {
    const {
      username,
      rawText,
      shortStartSec,
      shortEndSec,
      movieStartSec,
      movieEndSec,
      modelName,
      onLog,
    } = params

    const cfg = await loadStudioUserConfig(username)
    let mode = cfg.studioOffsetMode

    // Parse raw timestamps with chunkOffset = 0 first to inspect the raw numbers returned by Gemini Studio
    const rawParsed = parseChunkMatches(rawText, 0, 0, modelName)
    const blockDur = Math.max(1, movieEndSec - movieStartSec)
    const shortPartDur = Math.max(1, shortEndSec - shortStartSec)

    if (rawParsed.length > 0 && movieStartSec >= 60) {
      // Check if raw movie timestamps clearly fall in [movieStartSec, movieEndSec] vs [0, blockDur]
      const looksAbsolute = rawParsed.every(
        (m) => m.movieStart >= movieStartSec - 5 && m.movieEnd <= movieEndSec + 10,
      ) && rawParsed.some((m) => m.movieStart > blockDur + 5)

      const looksRelative = rawParsed.every(
        (m) => m.movieStart >= 0 && m.movieEnd <= blockDur + 10,
      ) && rawParsed.some((m) => m.movieStart < movieStartSec - 5)

      if (looksAbsolute && mode !== 'absolute') {
        mode = 'absolute'
        await saveStudioUserConfig(username, { studioOffsetMode: 'absolute' })
        onLog?.(
          'info',
          `Studio Timestamp Calibration: detected ABSOLUTE timestamps (model reports timestamps from full video clock ${fmtTime(movieStartSec)}–${fmtTime(movieEndSec)}). Saved calibration = absolute.`,
        )
      } else if (looksRelative && mode !== 'relative') {
        mode = 'relative'
        await saveStudioUserConfig(username, { studioOffsetMode: 'relative' })
        onLog?.(
          'info',
          `Studio Timestamp Calibration: detected RELATIVE timestamps (model reports 00:00-based clip timestamps for window ${fmtTime(movieStartSec)}–${fmtTime(movieEndSec)}). Saved calibration = relative.`,
        )
      }
    }

    const effectiveMode: 'relative' | 'absolute' = mode === 'absolute' ? 'absolute' : 'relative'
    const movieOffsetToAdd = effectiveMode === 'relative' ? movieStartSec : 0

    // Call unchanged parseChunkMatches from lib/gemini.ts with the calibrated movieOffset!
    const parsedWithMovieOffset = parseChunkMatches(rawText, 0, movieOffsetToAdd, modelName)

    // Apply the same calibrated offset logic to the short timestamps and clamp within the short part window
    const finalMatches = parsedWithMovieOffset
      .map((m) => {
        const shortIsAlreadyAbsolute =
          effectiveMode === 'absolute' ||
          (shortStartSec >= 60 && m.shortStart >= shortStartSec - 2 && m.shortEnd <= shortEndSec + 5)
        const absShortStart = shortIsAlreadyAbsolute ? m.shortStart : shortStartSec + m.shortStart
        const absShortEnd = shortIsAlreadyAbsolute ? m.shortEnd : shortStartSec + m.shortEnd
        return {
          ...m,
          shortStart: Math.min(shortEndSec, Math.max(shortStartSec, absShortStart)),
          shortEnd: Math.min(shortEndSec, Math.max(shortStartSec, absShortEnd)),
        }
      })
      .filter((m) => m.shortEnd - m.shortStart > 0.02)

    return { matches: finalMatches, offsetMode: effectiveMode }
  }
}

const globalForStudio = globalThis as unknown as {
  __cmtStudioController?: StudioBrowserController
}

export const studioController =
  globalForStudio.__cmtStudioController ||
  (globalForStudio.__cmtStudioController = new StudioBrowserController())
