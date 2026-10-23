import fs from 'fs'
import path from 'path'
import { chromium, type BrowserContext, type Page, type Response as PlaywrightResponse } from 'playwright'
import { DATA_DIR } from './paths'
import {
  STUDIO_SELECTORS,
  STUDIO_URLS,
  findFirstVisibleLocator,
} from './studio-selectors'
import {
  computeEffectiveMaxInputTokens,
  encryptSecret,
  loadDecryptedPlaywrightCookies,
  loadStudioUserConfig,
  saveStudioUserConfig,
} from './studio-settings'
import { buildStudioChunkPrompt } from './studio-prompt'
import { parseChunkMatches } from './gemini'
import { validateStudioAnswer, type StudioValidationResult } from './studio-result-validator'
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
  status: 'running' | 'pass' | 'fail' | 'error' | 'stopped'
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

  public async ensurePage(username: string, _forceReloadCookies = false): Promise<Page> {
    if (this.page && !this.page.isClosed() && this.context) {
      await this.context
        .grantPermissions(['clipboard-read', 'clipboard-write'], {
          origin: 'https://aistudio.google.com',
        })
        .catch(() => {})
      this.lastInjectedCookieUser = username
      return this.page
    }

    if (this.launching) return this.launching

    this.launching = (async () => {
      try {
        const profileDir = path.join(DATA_DIR, 'studio-chromium-profile')
        if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true })

        // Clean up any stale SingletonLock from an unclean restart
        for (const lockName of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
          const lockFile = path.join(profileDir, lockName)
          try {
            if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile)
          } catch {
            /* ignore */
          }
        }

        const baseArgs = [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
          '--window-size=1366,840',
        ]

        // Launch headed real Chrome (channel: 'chrome', headless: false) with persistent user-data-dir.
        // Do NOT inject cookies here — the user logs in once in the persistent profile.
        this.logStep(
          'browser launching',
          'Starting headed real Chrome (channel: chrome) with persistent user-data-dir',
        )
        try {
          this.context = await chromium.launchPersistentContext(profileDir, {
            headless: false,
            channel: 'chrome',
            viewport: VIEWPORT,
            args: baseArgs,
          })
        } catch (chromeErr) {
          // Fallback if system 'chrome' channel or X server is unavailable in container
          try {
            this.context = await chromium.launchPersistentContext(profileDir, {
              headless: false,
              viewport: VIEWPORT,
              args: baseArgs,
            })
          } catch {
            this.logStep(
              'browser fallback',
              `Headed Chrome launch unavailable (${chromeErr instanceof Error ? chromeErr.message.slice(0, 80) : 'no display'}), using persistent profile context`,
              'warn',
            )
            this.context = await chromium.launchPersistentContext(profileDir, {
              headless: true,
              viewport: VIEWPORT,
              args: baseArgs,
            })
          }
        }

        await this.context
          .grantPermissions(['clipboard-read', 'clipboard-write'], {
            origin: 'https://aistudio.google.com',
          })
          .catch(() => {})

        const pages = this.context.pages()
        this.page = pages.length > 0 ? pages[0] : await this.context.newPage()
        await this.page.setViewportSize(VIEWPORT)

        this.lastInjectedCookieUser = username
        return this.page
      } finally {
        this.launching = null
      }
    })()

    return this.launching
  }

  /**
   * Persist updated/rotated Google cookies and storage state from the persistent browser context
   * after every job (Google cookies rotate frequently during active sessions).
   */
  public async saveRotatedSessionFromContext(username: string): Promise<void> {
    if (!this.context) return
    try {
      const profileDir = path.join(DATA_DIR, 'studio-chromium-profile')
      const statePath = path.join(profileDir, 'storage-state.json')
      const state = await this.context.storageState({ path: statePath })
      const rotatedCookies = await this.context.cookies([
        'https://aistudio.google.com',
        'https://accounts.google.com',
        'https://google.com',
      ])
      const cookiesToSave = rotatedCookies.length > 0 ? rotatedCookies : state.cookies
      if (cookiesToSave.length > 0) {
        const encrypted = encryptSecret(JSON.stringify(cookiesToSave))
        await saveStudioUserConfig(username, {
          encryptedCookies: encrypted,
          cookiesUpdatedAt: Date.now(),
        })
      }
    } catch {
      /* ignore cookie rotation persistence warning */
    }
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
   * Also saves rotated cookies/profile after every finished job.
   */
  public async recordFinishedWindowJobAndMaybeRecyclePage(
    username: string,
    recycleInterval?: number,
    onLog?: (level: 'info' | 'warn' | 'error' | 'success', msg: string) => void,
  ): Promise<void> {
    await this.saveRotatedSessionFromContext(username)
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
      await this.context
        .grantPermissions(['clipboard-read', 'clipboard-write'], {
          origin: 'https://aistudio.google.com',
        })
        .catch(() => {})
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
   * Check whether the right-hand Run Settings panel is currently open and whether its inner
   * elements (model selector and/or Thinking level dropdown) are visible in the DOM.
   * IMPORTANT: Never trust `aria-expanded` on `button[aria-label="Toggle run settings panel"]`
   * because in a new chat the panel is ALREADY OPEN by default while `aria-expanded` may be unset/false.
   */
  private async getRunSettingsPanelState(page: Page): Promise<{
    open: boolean
    hasModelSelector: boolean
    hasThinkingLevel: boolean
  }> {
    try {
      return await page.evaluate(
        ({ modelSels, thinkSels }) => {
          const isElementVisibleOnScreen = (el: Element | null): el is HTMLElement => {
            if (!el) return false
            const h = el as HTMLElement
            const r = h.getBoundingClientRect()
            const style = window.getComputedStyle(h)
            return (
              r.width > 20 &&
              r.height > 14 &&
              r.right > 0 &&
              r.left < window.innerWidth &&
              r.bottom > 0 &&
              r.top < window.innerHeight &&
              style.visibility !== 'hidden' &&
              style.display !== 'none' &&
              style.opacity !== '0' &&
              h.getAttribute('aria-hidden') !== 'true'
            )
          }

          let hasModelSelector = false
          for (const sel of modelSels) {
            try {
              const nodes = Array.from(document.querySelectorAll(sel))
              if (nodes.some((n) => isElementVisibleOnScreen(n))) {
                hasModelSelector = true
                break
              }
            } catch {
              /* ignore */
            }
          }

          let hasThinkingLevel = false
          for (const sel of thinkSels) {
            try {
              const nodes = Array.from(document.querySelectorAll(sel))
              if (nodes.some((n) => isElementVisibleOnScreen(n))) {
                hasThinkingLevel = true
                break
              }
            } catch {
              /* ignore */
            }
          }

          if (!hasThinkingLevel) {
            const all = Array.from(document.body.querySelectorAll('*'))
            for (const el of all) {
              if (!isElementVisibleOnScreen(el)) continue
              if (el.children.length > 2) continue
              const t = ((el as HTMLElement).innerText || el.textContent || '').trim()
              if (/^thinking\s*(level|budget)?$/i.test(t)) {
                hasThinkingLevel = true
                break
              }
            }
          }

          let hasContainer = false
          const containers = Array.from(
            document.querySelectorAll(
              'ms-run-settings, ms-runsettings, ms-run-settings-panel, ms-runsettings-panel, aside.runsettings-panel, div.runsettings-panel, [class*="runsettings-panel" i], [class*="run-settings-panel" i]',
            ),
          )
          for (const c of containers) {
            const r = c.getBoundingClientRect()
            if (isElementVisibleOnScreen(c) && r.left > window.innerWidth * 0.45 && r.width >= 160) {
              hasContainer = true
              break
            }
          }

          return {
            open: hasModelSelector || hasThinkingLevel || hasContainer,
            hasModelSelector,
            hasThinkingLevel,
          }
        },
        {
          modelSels: [...STUDIO_SELECTORS.modelSelectorTrigger],
          thinkSels: [...STUDIO_SELECTORS.thinkingLevelSelect],
        },
      )
    } catch {
      return { open: false, hasModelSelector: false, hasThinkingLevel: false }
    }
  }

  /**
   * Dismiss any open dropdown / menu overlay (.cdk-overlay-pane) using Escape ONLY when an overlay is open,
   * never clicking outside the panel where it could accidentally close the Run Settings panel.
   */
  private async dismissOpenOverlayIfAny(page: Page): Promise<void> {
    try {
      const hasOpenOverlay = await page.evaluate(() => {
        const activeOverlay = document.querySelector(
          '.cdk-overlay-pane [role="menu"], .cdk-overlay-pane [role="listbox"], .cdk-overlay-pane mat-option, .cdk-overlay-pane [role="option"]',
        ) as HTMLElement | null
        return Boolean(activeOverlay && activeOverlay.getBoundingClientRect().height > 0)
      })
      if (hasOpenOverlay) {
        await page.keyboard.press('Escape').catch(() => {})
        await new Promise((r) => setTimeout(r, 200))
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Wait for the Run Settings panel elements (model selector, thinking level dropdown) to become
   * visible after a new chat loads (max ~5s).
   *
   * CRITICAL: In a new chat, the Run Settings panel is ALREADY OPEN by default.
   * Do NOT click `button[aria-label="Toggle run settings panel"]` when the panel is already open,
   * or it will close the panel!
   * Only if the panel is genuinely closed after waiting up to ~5s (neither model selector nor
   * thinking level is visible in DOM), click the toggle button ONCE and verify it opened.
   */
  private async waitForRunSettingsPanelElements(page: Page, maxWaitMs = 5000): Promise<{
    open: boolean
    hasModelSelector: boolean
    hasThinkingLevel: boolean
  }> {
    const deadline = Date.now() + maxWaitMs
    while (Date.now() < deadline) {
      const state = await this.getRunSettingsPanelState(page)
      if (state.hasThinkingLevel || (state.open && state.hasModelSelector)) {
        return state
      }
      await new Promise((r) => setTimeout(r, 250))
    }

    let state = await this.getRunSettingsPanelState(page)
    if (state.open) {
      return state
    }

    // Panel is genuinely closed even after waiting 5s -> click toggle ONCE to open it
    this.logStep(
      'opening run settings',
      'Panel confirmed closed after 5s wait -> clicking Toggle run settings panel once',
      'info',
    )
    const toggle = await findFirstVisibleLocator(page, STUDIO_SELECTORS.runSettingsToggle, 2000)
    if (toggle) {
      await toggle.click().catch(() => {})
    } else {
      await page
        .evaluate(() => {
          const btn = document.querySelector(
            'button[aria-label="Toggle run settings panel" i], button.runsettings-toggle-button',
          ) as HTMLElement | null
          if (btn) btn.click()
        })
        .catch(() => {})
    }

    const afterClickDeadline = Date.now() + 5000
    while (Date.now() < afterClickDeadline) {
      await new Promise((r) => setTimeout(r, 250))
      state = await this.getRunSettingsPanelState(page)
      if (state.hasThinkingLevel || state.open) {
        return state
      }
    }

    return await this.getRunSettingsPanelState(page)
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
            if (
              t &&
              !isWelcomeHeading(t) &&
              (/gemini/i.test(t) || /3\.[678]/i.test(t) || /2\.5/i.test(t))
            ) {
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
            /\bgemini[\s-]+3\.[678]\b/i.test(t) ||
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
   * Select a specific model (e.g. "Gemini 3.8 Flash", "Gemini 3.7 Flash", "Gemini 3.6 Flash")
   * in the Run Settings panel if it is not already selected.
   */
  private async selectModelInRunSettings(page: Page, targetModelName: string): Promise<string> {
    const desired = (targetModelName || 'Gemini 3.8 Flash').trim()
    const versionMatch = desired.match(/(\d+\.\d+)/)
    const desiredVersion = versionMatch ? versionMatch[1] : ''
    const isFlash = /flash/i.test(desired)

    const matchesDesired = (text: string): boolean => {
      if (!text) return false
      if (desiredVersion) {
        const hasVer = text.includes(desiredVersion)
        const hasVariant = !isFlash || /flash/i.test(text)
        return hasVer && hasVariant
      }
      return text.toLowerCase().includes(desired.toLowerCase())
    }

    const currentCardText = await this.readVisibleModelCardText(page)
    if (matchesDesired(currentCardText)) {
      return currentCardText
    }

    // If default 3.8 Flash was requested and some default model is already loaded, keep it unless fallback was requested
    if (!desiredVersion || desiredVersion === '3.8') {
      if (!currentCardText || matchesDesired(currentCardText)) {
        return currentCardText || desired
      }
    }

    this.logStep('selecting model', `Switching model to "${desired}" (current="${currentCardText || 'default'}")`, 'info')

    const trigger = await findFirstVisibleLocator(page, STUDIO_SELECTORS.modelSelectorTrigger, 2500)
    if (trigger) {
      await trigger.click().catch(() => {})
      await new Promise((r) => setTimeout(r, 450))

      const clickedModel = await page
        .evaluate(
          ({ ver, wantFlash, fullLabel }) => {
            const isVisible = (el: Element | null): el is HTMLElement => {
              if (!el) return false
              const h = el as HTMLElement
              const r = h.getBoundingClientRect()
              return r.width > 0 && r.height > 0 && window.getComputedStyle(h).visibility !== 'hidden'
            }

            // Search inside overlay panes / model picker lists first
            const roots = Array.from(
              document.querySelectorAll(
                '.cdk-overlay-pane, mat-dialog-container, [role="listbox"], [role="menu"], ms-model-carousel, [class*="model-list" i], [class*="model-picker" i]',
              ),
            ).filter((el) => isVisible(el))

            const candidates: HTMLElement[] = []
            for (const root of roots) {
              root
                .querySelectorAll(
                  'mat-option, [role="option"], [role="menuitem"], button, [class*="model-card" i], [class*="model-item" i], [class*="model-row" i]',
                )
                .forEach((n) => {
                  if (isVisible(n)) candidates.push(n as HTMLElement)
                })
            }

            for (const c of candidates) {
              const txt = (c.innerText || c.textContent || '').trim().replace(/\s+/g, ' ')
              if (!txt) continue
              if (ver) {
                if (txt.includes(ver) && (!wantFlash || /flash/i.test(txt)) && !/lite/i.test(txt)) {
                  c.click()
                  return txt
                }
              } else if (txt.toLowerCase().includes(fullLabel.toLowerCase())) {
                c.click()
                return txt
              }
            }
            return null
          },
          { ver: desiredVersion, wantFlash: isFlash, fullLabel: desired },
        )
        .catch(() => null)

      await new Promise((r) => setTimeout(r, 400))
      await this.dismissOpenOverlayIfAny(page)

      const updatedCardText = (await this.readVisibleModelCardText(page)) || clickedModel || desired
      this.logStep('model selected', `Active model in Run Settings: ${updatedCardText}`, 'info')
      return updatedCardText
    }

    return currentCardText || desired
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
   * Step (b):
   * - In a new chat, the Run Settings panel (tune / three-dot panel) is ALREADY OPEN by default.
   * - Do NOT click `button[aria-label="Toggle run settings panel"]` on new chat load (doing so closes the panel!).
   * - Flow: wait for panel elements (model selector, thinking level dropdown) to appear (max ~5s) ->
   *   select model (or fallback model) and set Thinking = High directly.
   * - Never click outside the panel while configuring. After dropdown selection, verify the panel is still open.
   * - If the dropdown is still not found, log "not found" along with the current panel state (open/closed).
   */
  private async configureRunSettings(
    page: Page,
    config: { modelName: string; maxOutputTokens: number },
    scope?: { scanId?: string | null; username?: string | null },
  ) {
    await this.waitIfPausedOrThrowIfStopped(scope)

    // 0. Wait up to ~5s for the already-open Run Settings panel elements to appear in DOM.
    // Only clicks Toggle run settings panel ONCE if the panel is genuinely closed after waiting.
    const initialPanelState = await this.waitForRunSettingsPanelElements(page, 5000)
    if (!initialPanelState.open) {
      const stateLabel = initialPanelState.open ? 'khula (open)' : 'band (closed)'
      await this.dumpRunSettingsPanelDiagnostics(
        page,
        `Run settings panel not open after wait (panel=${stateLabel})`,
      )
      throw new Error(
        `Studio thinking level config failed: Run settings panel not found (panel=${stateLabel})`,
      )
    }

    // 1. Select requested or fallback model (e.g. Gemini 3.8 Flash, 3.7 Flash, 3.6 Flash)
    const activeModelText = await this.selectModelInRunSettings(page, config.modelName)

    // 2. Set "Thinking level" dropdown to High & READ BACK visible value
    let verifiedThinkingText = ''
    let thinkingConfigError = ''

    for (let thinkAttempt = 1; thinkAttempt <= 2; thinkAttempt++) {
      await this.waitIfPausedOrThrowIfStopped(scope)
      thinkingConfigError = ''

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

      // Search for Thinking level dropdown inside the open Run Settings panel
      let thinkSelect = await findFirstVisibleLocator(page, STUDIO_SELECTORS.thinkingLevelSelect, 3000)
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
        const pState = await this.getRunSettingsPanelState(page)
        const stateDesc = pState.open ? 'khula (open)' : 'band (closed)'
        thinkingConfigError = `Thinking level dropdown selector not found (panel=${stateDesc}, modelSelector=${pState.hasModelSelector}, thinkingLevel=${pState.hasThinkingLevel})`
        if (thinkAttempt >= 2) {
          await this.dumpRunSettingsPanelDiagnostics(page, `${thinkingConfigError} (attempt ${thinkAttempt}/2)`)
        }
      } else {
        const beforeThink = await this.readVisibleThinkingLevelText(page)
        if (!/\bhigh\b/i.test(beforeThink)) {
          await thinkSelect.scrollIntoViewIfNeeded().catch(() => {})
          await thinkSelect.click().catch(() => {})
          await new Promise((r) => setTimeout(r, 350))

          // Click "High" strictly inside the opened overlay pane so we never click outside the panel
          const highOpt = page
            .locator(
              '.cdk-overlay-pane mat-option:has-text("High"), .cdk-overlay-pane [role="option"]:has-text("High"), .cdk-overlay-pane [role="menuitem"]:has-text("High"), mat-option:has-text("High"), [role="option"]:has-text("High")',
            )
            .first()

          if ((await highOpt.count()) > 0 && (await highOpt.isVisible().catch(() => false))) {
            await highOpt.click().catch(() => {})
            await new Promise((r) => setTimeout(r, 350))
          } else {
            const pState = await this.getRunSettingsPanelState(page)
            const stateDesc = pState.open ? 'khula (open)' : 'band (closed)'
            thinkingConfigError = `"High" option not found after opening Thinking level dropdown (panel=${stateDesc})`
            if (thinkAttempt >= 2) {
              await this.dumpRunSettingsPanelDiagnostics(page, `${thinkingConfigError} (attempt ${thinkAttempt}/2)`)
            }
            await this.dismissOpenOverlayIfAny(page)
          }
        }

        // Verify panel is still open after dropdown selection (do not toggle if closed, just check state)
        const postSelectState = await this.getRunSettingsPanelState(page)
        const readBackThink = await this.readVisibleThinkingLevelText(page)
        if (/\bhigh\b/i.test(readBackThink)) {
          verifiedThinkingText = readBackThink
          break
        }
        if (!thinkingConfigError) {
          const stateDesc = postSelectState.open ? 'khula (open)' : 'band (closed)'
          thinkingConfigError = `expected "High", read back "${readBackThink || 'empty'}" (panel=${stateDesc})`
        }
        if (thinkAttempt >= 2) {
          await this.dumpRunSettingsPanelDiagnostics(page, `thinking level read-back mismatch: ${thinkingConfigError}`)
        }
      }

      if (thinkAttempt >= 2 && thinkingConfigError) {
        throw new Error(`Studio thinking level config failed: ${thinkingConfigError}`)
      }
    }

    // 3. Ensure Advanced Settings is expanded if needed for Output length (do not collapse if already expanded)
    try {
      const outputLengthVisible = await page
        .evaluate(() => /output\s+length/i.test(document.body.innerText || ''))
        .catch(() => false)

      if (!outputLengthVisible) {
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

    // 4. Set Output length (maxOutputTokens) if needed
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

    // Final read-back verification (keep Run Settings panel open — do NOT click Toggle run settings panel)
    const finalThinkingReadBack = (await this.readVisibleThinkingLevelText(page)) || verifiedThinkingText
    if (!/\bhigh\b/i.test(finalThinkingReadBack)) {
      const pState = await this.getRunSettingsPanelState(page)
      const stateDesc = pState.open ? 'khula (open)' : 'band (closed)'
      await this.dumpRunSettingsPanelDiagnostics(
        page,
        `final thinking read-back check failed: "${finalThinkingReadBack}" (panel=${stateDesc})`,
      )
      throw new Error(
        `Studio thinking level config failed: expected "High", read back "${finalThinkingReadBack || 'empty'}" (panel=${stateDesc})`,
      )
    }

    this.logStep(
      'model set',
      `thinking=High · model=${activeModelText || config.modelName || 'default'}`,
      'success',
    )
  }

  /**
   * Problem 1(a): Detect chips by anchoring on button[aria-label="Edit video options" i]
   * (and/or button[aria-label="Remove media" i]).
   * A chip = the nearest ancestor of that button that contains BOTH:
   *   - exactly one Edit button (button[aria-label="Edit video options" i] / video options)
   *   - and one Remove button (button[aria-label="Remove media" i]).
   * Tags each detected chip with `data-cmt-fallback-chip="true"` (keeping ms-* CSS selectors as primary).
   * No filename or "N tokens" text dependency.
   */
  private async syncFallbackMediaChips(page: Page, _uploadedBasename?: string): Promise<void> {
    const primarySelector = STUDIO_SELECTORS.videoMediaChipsCss.join(', ')
    await page
      .evaluate((primarySel) => {
        try {
          document
            .querySelectorAll('[data-cmt-fallback-chip]')
            .forEach((el) => el.removeAttribute('data-cmt-fallback-chip'))
        } catch {
          /* ignore */
        }

        const primarySet = new Set<Element>()
        if (primarySel) {
          try {
            Array.from(document.querySelectorAll(primarySel)).forEach((el) => primarySet.add(el))
          } catch {
            /* ignore */
          }
        }

        const editBtnSel =
          'button[aria-label="Edit video options" i], button[aria-label*="Edit video options" i], button[aria-label*="Video options" i], button[aria-label*="Video settings" i], [role="button"][aria-label*="Edit video options" i]'
        const removeBtnSel =
          'button[aria-label="Remove media" i], button[aria-label*="Remove media" i], [role="button"][aria-label*="Remove media" i]'

        let editButtons: Element[] = []
        try {
          editButtons = Array.from(document.body.querySelectorAll(editBtnSel))
        } catch {
          editButtons = []
        }

        const foundChips: Element[] = []

        for (const editBtn of editButtons) {
          let curr: Element | null = editBtn.parentElement
          for (let depth = 0; depth < 8 && curr && curr !== document.body; depth++) {
            let editCount = 0
            let removeCount = 0
            try {
              editCount = curr.querySelectorAll(editBtnSel).length
            } catch {
              editCount = 0
            }
            try {
              removeCount = curr.querySelectorAll(removeBtnSel).length
            } catch {
              removeCount = 0
            }
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
          let removeButtons: Element[] = []
          try {
            removeButtons = Array.from(document.body.querySelectorAll(removeBtnSel))
          } catch {
            removeButtons = []
          }
          for (const remBtn of removeButtons) {
            let curr: Element | null = remBtn.parentElement
            for (let depth = 0; depth < 8 && curr && curr !== document.body; depth++) {
              let removeCount = 0
              let allBtns = 0
              try {
                removeCount = curr.querySelectorAll(removeBtnSel).length
              } catch {
                removeCount = 0
              }
              try {
                allBtns = curr.querySelectorAll('button, [role="button"]').length
              } catch {
                allBtns = 0
              }
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
      .catch((err: unknown) => {
        this.logStep('chip sync error', (err as Error)?.message || String(err), 'warn')
      })
  }

  /**
   * Read the top header token count silently (without logging to step log on every poll tick).
   */
  private async readHeaderTokenCountSilent(page: Page): Promise<number> {
    try {
      return await page.evaluate(() => {
        const isVisible = (el: Element | null): el is HTMLElement => {
          if (!el) return false
          const h = el as HTMLElement
          const r = h.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && window.getComputedStyle(h).visibility !== 'hidden'
        }

        let headerTokens = 0
        try {
          const topNodes = Array.from(document.body.querySelectorAll('span, div, button, p'))
          for (const node of topNodes) {
            if (!isVisible(node)) continue
            const r = node.getBoundingClientRect()
            if (r.top < 0 || r.top > 120 || r.height > 65) continue
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
        } catch {
          /* ignore */
        }
        return headerTokens
      })
    } catch {
      return 0
    }
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
   * verify media chip count increased (or Remove media button count / header token count increased),
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

    // Combined locator: videoMediaChipsCss + videoMediaChipsPw + fallback chip locator ([data-cmt-fallback-chip="true"])
    const combinedChipSelector = [
      ...STUDIO_SELECTORS.videoMediaChipsCss,
      ...STUDIO_SELECTORS.videoMediaChipsPw,
      '[data-cmt-fallback-chip="true"]',
    ].join(', ')
    const chipsLocator = page.locator(combinedChipSelector)
    const removeMediaBtnLocator = page.locator('button[aria-label="Remove media" i]')

    await this.syncFallbackMediaChips(page)
    const chipsBefore = await chipsLocator.count()
    const removeBefore = await removeMediaBtnLocator.count().catch(() => 0)
    const headerTokensBefore = await this.readHeaderTokenCountSilent(page)

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

    // FIX 1a: Wait for the new video chip to appear (via chip count increase OR second success signal:
    // button[aria-label="Remove media" i] count increased OR header token count increased)
    // AND wait until the chip finishes "Loading..." so its gear button ("Edit video options") is ready.
    // A local 390 MB upload can take longer than 90s, so use a 5-minute (300_000ms) deadline for local file uploads.
    const isLocalFileUpload = Boolean(!youtubeUrl && !driveFileName && localFilePath)
    const waitTimeoutMs = isLocalFileUpload ? 300_000 : 90_000
    const uploadWaitStartedAt = Date.now()
    const waitDeadline = uploadWaitStartedAt + waitTimeoutMs
    let chipCount = chipsBefore
    let removeAfter = removeBefore
    let headerTokensAfter = headerTokensBefore
    let attachSucceeded = false
    let lastLoggedUploadSec = -1

    while (Date.now() < waitDeadline) {
      await this.waitIfPausedOrThrowIfStopped(scope)
      await this.syncFallbackMediaChips(page)
      chipCount = await chipsLocator.count()
      removeAfter = await removeMediaBtnLocator.count().catch(() => 0)
      headerTokensAfter = await this.readHeaderTokenCountSilent(page)

      const primarySignal = chipCount > chipsBefore
      const secondarySignal =
        removeAfter > removeBefore || (headerTokensAfter > headerTokensBefore && headerTokensAfter > 0)

      if (primarySignal || secondarySignal) {
        if (chipCount > chipsBefore) {
          const candidateChip = chipsLocator.nth(chipsBefore)
          const chipText = ((await candidateChip.innerText().catch(() => '')) || '').trim()
          const gearBtnCount = await candidateChip
            .locator(
              'button[aria-label*="Edit video options" i], button[aria-label*="Video options" i], button[aria-label*="Video settings" i]',
            )
            .count()
            .catch(() => 0)
          // As shown in video 01:54 -> 01:56, while "Loading..." is displayed the gear icon is not ready yet
          if (gearBtnCount > 0 || !/\bloading\b/i.test(chipText)) {
            attachSucceeded = true
            break
          }
        } else {
          // Secondary signal triggered while chip is still Loading... — wait until Edit video options button appears and syncs
          const editBtnCountOnPage = await page
            .locator('button[aria-label="Edit video options" i], button[aria-label*="Edit video options" i]')
            .count()
            .catch(() => 0)
          if (editBtnCountOnPage > chipsBefore) {
            await this.syncFallbackMediaChips(page)
            chipCount = await chipsLocator.count()
            attachSucceeded = true
            break
          }
        }
      }

      const elapsedUploadSec = Math.max(1, Math.floor((Date.now() - uploadWaitStartedAt) / 1000))
      if (isLocalFileUpload && elapsedUploadSec !== lastLoggedUploadSec) {
        lastLoggedUploadSec = elapsedUploadSec
        this.logStep(
          `uploading ${uploadedBasename || `${label}.mp4`} to AI Studio... ${elapsedUploadSec}s`,
          label,
        )
      }

      await new Promise((r) => setTimeout(r, 1000))
    }

    if (!attachSucceeded) {
      await this.syncFallbackMediaChips(page)
      chipCount = await chipsLocator.count()
      removeAfter = await removeMediaBtnLocator.count().catch(() => 0)
      headerTokensAfter = await this.readHeaderTokenCountSilent(page)
      if (
        chipCount > chipsBefore ||
        removeAfter > removeBefore ||
        (headerTokensAfter > headerTokensBefore && headerTokensAfter > 0)
      ) {
        attachSucceeded = true
      }
    }

    if (!attachSucceeded) {
      await this.dumpChipAttachDiagnostics(page, label, uploadedBasename)
      throw new Error(
        `Studio video attach failed for ${label}: media chip count did not increase within ${Math.round(waitTimeoutMs / 1000)}s (before=${chipsBefore}, after=${chipCount}, removeBefore=${removeBefore}, removeAfter=${removeAfter}, tokensBefore=${headerTokensBefore}, tokensAfter=${headerTokensAfter})`,
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
      // Wait 10 seconds after clicking Save in the Video settings dialog before doing anything else
      await new Promise((r) => setTimeout(r, 10_000))

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
   * Check whether the AI Studio "thinking / running" spinner is currently visible,
   * strictly scoped to ONLY the last model turn OR the Run/Stop button (never page-wide generic spinners).
   */
  private async isThinkingOrRunningSpinnerVisible(page: Page): Promise<boolean> {
    const turnSelectors = STUDIO_SELECTORS.modelTurnContainers
    return page
      .evaluate((turnSels) => {
        const isVisible = (el: Element | null): boolean => {
          if (!el) return false
          const h = el as HTMLElement
          const r = h.getBoundingClientRect()
          if (r.width <= 0 || r.height <= 0) return false
          const style = window.getComputedStyle(h)
          return style.visibility !== 'hidden' && style.display !== 'none' && parseFloat(style.opacity || '1') > 0
        }

        const spinnerQuery = 'mat-spinner, mat-progress-spinner, .mat-mdc-progress-spinner, [role="progressbar"]'

        // 1. Check inside the LAST model turn only
        let turns: Element[] = []
        for (const sel of turnSels) {
          if (sel.includes(':has-text(')) continue
          try {
            const found = Array.from(document.querySelectorAll(sel))
            if (found.length > 0) {
              turns = found
              break
            }
          } catch {
            // ignore
          }
        }
        const lastTurn = turns[turns.length - 1]
        if (lastTurn) {
          const turnSpinners = Array.from(lastTurn.querySelectorAll(spinnerQuery))
          if (turnSpinners.some((s) => isVisible(s))) return true
        }

        // 2. Check inside ms-run-button / button.run-button only
        const runContainers = Array.from(document.querySelectorAll('ms-run-button, button.run-button'))
        for (const rc of runContainers) {
          const runSpinners = Array.from(rc.querySelectorAll(spinnerQuery))
          if (runSpinners.some((s) => isVisible(s))) return true
        }

        return false
      }, [...turnSelectors])
      .catch(() => false)
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
          if (sel.includes(':has-text(')) continue
          try {
            const found = Array.from(document.querySelectorAll(sel))
            if (found.length > 0) {
              turns = found
              break
            }
          } catch {
            // ignore invalid CSS selector
          }
        }
        const lastTurn = turns[turns.length - 1]
        if (!lastTurn) return ''

        // Clone the DOM node so we can safely remove all thought/thinking elements before reading innerText
        const clone = lastTurn.cloneNode(true) as HTMLElement
        for (const tSel of thoughtSels) {
          if (tSel.includes(':has-text(')) continue
          try {
            clone.querySelectorAll(tSel).forEach((el) => el.remove())
          } catch {
            // ignore invalid CSS selector
          }
        }

        // Remove thought panels in JS: for every 'mat-expansion-panel, details' inside the cloned last turn,
        // if its innerText starts with "Thoughts" or "Thinking" (case-insensitive), remove it.
        try {
          clone.querySelectorAll('mat-expansion-panel, details').forEach((el) => {
            const txt = ((el as HTMLElement).innerText || el.textContent || '').trim()
            if (/^(thoughts|thinking)\b/i.test(txt)) {
              el.remove()
            }
          })
        } catch {
          // ignore
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
   * CHANGE 3: Fetch the final answer via the AI Studio UI ("Copy as text" on the last model turn's
   * three-dot options menu -> clipboard with sentinel guard), falling back to coordinate ratios
   * and finally to DOM extraction (`extractFinalAnswerWithoutThoughts`).
   * Total time cap: ~15 seconds.
   */
  private async fetchStudioResultFromTurnOrFallback(
    page: Page,
  ): Promise<{ text: string; source: 'clipboard' | 'dom' }> {
    const fetchDeadline = Date.now() + 15_000

    if (this.context) {
      await this.context
        .grantPermissions(['clipboard-read', 'clipboard-write'], {
          origin: 'https://aistudio.google.com',
        })
        .catch(() => {})
    }

    const writeSentinel = async (): Promise<string> => {
      const sentinel = `__CMT_SENTINEL_${Date.now()}_${Math.random().toString(36).slice(2, 7)}__`
      await page
        .evaluate(async (s) => {
          try {
            await navigator.clipboard.writeText(s)
          } catch {
            // ignore
          }
        }, sentinel)
        .catch(() => {})
      return sentinel
    }

    const readClipboardUntilChanged = async (sentinel: string, maxWaitMs = 3000): Promise<string | null> => {
      const waitEnd = Math.min(fetchDeadline, Date.now() + maxWaitMs)
      while (Date.now() < waitEnd) {
        const txt = await page
          .evaluate(async () => {
            try {
              return await navigator.clipboard.readText()
            } catch {
              return ''
            }
          })
          .catch(() => '')
        if (txt && txt !== sentinel && !txt.startsWith('__CMT_SENTINEL_')) {
          return txt.trim()
        }
        await new Promise((r) => setTimeout(r, 100))
      }
      return null
    }

    const clickCopyAsTextInOpenMenu = async (): Promise<string | null> => {
      for (const itemSel of STUDIO_SELECTORS.copyAsTextMenuItem) {
        try {
          const itemLoc = page.locator(itemSel).first()
          if ((await itemLoc.count()) > 0 && (await itemLoc.isVisible().catch(() => false))) {
            const itemText = ((await itemLoc.innerText().catch(() => '')) || '').trim()
            // Strict safety: ONLY click "Copy as text", never "Copy as markdown", "Delete", or "Branch from here"
            if (/copy\s+as\s+text/i.test(itemText) && !/markdown|delete|branch/i.test(itemText)) {
              const sentinel = await writeSentinel()
              await itemLoc.click({ timeout: 1500 })
              const copied = await readClipboardUntilChanged(sentinel, 3000)
              if (copied) return copied
            }
          }
        } catch {
          // try next selector
        }
      }
      return null
    }

    // Find the last model turn Locator
    let lastTurnLoc: ReturnType<Page['locator']> | null = null
    for (const tSel of STUDIO_SELECTORS.modelTurnContainers) {
      try {
        const allTurns = page.locator(tSel)
        const cnt = await allTurns.count()
        if (cnt > 0) {
          lastTurnLoc = allTurns.nth(cnt - 1)
          break
        }
      } catch {
        // ignore
      }
    }

    // Fallback (a): UI flow using DOM locators scoped strictly inside lastTurn (max 3 tries)
    if (lastTurnLoc) {
      for (let copyTry = 1; copyTry <= 3 && Date.now() < fetchDeadline; copyTry++) {
        try {
          await lastTurnLoc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {})
          const turnBox = await lastTurnLoc.boundingBox().catch(() => null)
          if (turnBox && turnBox.width > 40 && turnBox.height > 20) {
            // Click near the center of the last model turn to reveal its turn options toolbar
            const clickX = Math.round(turnBox.x + turnBox.width * 0.5)
            const clickY = Math.round(
              Math.max(85, Math.min(VIEWPORT.height - 60, turnBox.y + Math.min(turnBox.height * 0.5, 220))),
            )
            await page.mouse.click(clickX, clickY)
          } else {
            await lastTurnLoc.hover({ timeout: 1500 }).catch(() => {})
          }
          await new Promise((r) => setTimeout(r, 250))

          // Find the three-dot (more_vert) button strictly inside lastTurnLoc and below the page header
          let clickedMoreBtn = false
          for (const btnSel of STUDIO_SELECTORS.turnOptionsButton) {
            const candidates = lastTurnLoc.locator(btnSel)
            const cCount = await candidates.count().catch(() => 0)
            for (let i = 0; i < cCount; i++) {
              const btn = candidates.nth(i)
              if (!(await btn.isVisible().catch(() => false))) continue
              const box = await btn.boundingBox().catch(() => null)
              // Must be below the top page header bar (y > 68)
              if (!box || box.y <= 68) continue

              const isInsideTurnAndNotHeader = await btn
                .evaluate((el) => {
                  if (el.closest('header, mat-toolbar, ms-toolbar, ms-header, .toolbar')) return false
                  return Boolean(el.closest('ms-chat-turn, [data-turn-role="model"], .model-turn'))
                })
                .catch(() => false)

              if (!isInsideTurnAndNotHeader) continue

              await btn.click({ timeout: 1500 })
              clickedMoreBtn = true
              break
            }
            if (clickedMoreBtn) break
          }

          if (clickedMoreBtn) {
            await new Promise((r) => setTimeout(r, 300))
            const copied = await clickCopyAsTextInOpenMenu()
            if (copied) {
              return { text: copied, source: 'clipboard' }
            }
            // Wrong menu opened or "Copy as text" not found — press Escape and retry
            await page.keyboard.press('Escape').catch(() => {})
            await new Promise((r) => setTimeout(r, 200))
          }
        } catch {
          await page.keyboard.press('Escape').catch(() => {})
        }
      }
    }

    // Fallback (b): Coordinate ratios on VIEWPORT (1366x840)
    // 1. Turn center: (0.586, 0.506) -> (800, 425)
    // 2. Turn three-dot: (0.742, 0.113) -> (1014, 95)
    // 3. "Copy as text" item: overlay locator first, or coordinate (0.792, 0.227) -> (1082, 191) if verified safe
    if (Date.now() < fetchDeadline) {
      try {
        if (lastTurnLoc) {
          await lastTurnLoc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {})
        }
        const turnClickX = Math.round(0.586 * VIEWPORT.width)
        const turnClickY = Math.round(0.506 * VIEWPORT.height)
        await page.mouse.click(turnClickX, turnClickY)
        await new Promise((r) => setTimeout(r, 250))

        const moreX = Math.round(0.742 * VIEWPORT.width)
        const moreY = Math.round(0.113 * VIEWPORT.height)
        // Verify element at (moreX, moreY) is not a top header bar button before clicking
        const safeToClickMoreAtCoord = await page
          .evaluate(
            ({ x, y }) => {
              const el = document.elementFromPoint(x, y)
              if (!el) return false
              if (el.closest('header, mat-toolbar, ms-toolbar, ms-header')) return false
              return true
            },
            { x: moreX, y: moreY },
          )
          .catch(() => false)

        if (safeToClickMoreAtCoord) {
          await page.mouse.click(moreX, moreY)
          await new Promise((r) => setTimeout(r, 300))

          // First try clicking the "Copy as text" item in the opened overlay via locator
          const copiedViaOverlay = await clickCopyAsTextInOpenMenu()
          if (copiedViaOverlay) {
            return { text: copiedViaOverlay, source: 'clipboard' }
          }

          // Otherwise check if (0.792, 0.227) points to "Copy as text"
          const copyX = Math.round(0.792 * VIEWPORT.width)
          const copyY = Math.round(0.227 * VIEWPORT.height)
          const isCopyAsTextAtCoord = await page
            .evaluate(
              ({ x, y }) => {
                const el = document.elementFromPoint(x, y) as HTMLElement | null
                if (!el) return false
                const item = (el.closest('[role="menuitem"], button, .mat-mdc-menu-item') || el) as HTMLElement
                const txt = (item.innerText || item.textContent || '').trim()
                return /copy\s+as\s+text/i.test(txt) && !/markdown|delete|branch/i.test(txt)
              },
              { x: copyX, y: copyY },
            )
            .catch(() => false)

          if (isCopyAsTextAtCoord) {
            const sentinel = await writeSentinel()
            await page.mouse.click(copyX, copyY)
            const copied = await readClipboardUntilChanged(sentinel, 3000)
            if (copied) {
              return { text: copied, source: 'clipboard' }
            }
          }
          await page.keyboard.press('Escape').catch(() => {})
        }
      } catch {
        await page.keyboard.press('Escape').catch(() => {})
      }
    }

    // Debug dump of buttons inside the last turn so selectors can be tuned if UI copy failed
    try {
      const turnButtonsDump = await page.evaluate((turnSels) => {
        let turns: Element[] = []
        for (const sel of turnSels) {
          if (sel.includes(':has-text(')) continue
          try {
            const found = Array.from(document.querySelectorAll(sel))
            if (found.length > 0) {
              turns = found
              break
            }
          } catch {
            // ignore
          }
        }
        const lastTurn = turns[turns.length - 1]
        if (!lastTurn) return 'no lastTurn found'
        const btns = Array.from(lastTurn.querySelectorAll('button, [role="button"]')).slice(0, 12)
        return btns
          .map((b) => {
            const h = b as HTMLElement
            const r = h.getBoundingClientRect()
            const aria = h.getAttribute('aria-label') || ''
            const txt = (h.innerText || h.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30)
            return `[aria="${aria}" txt="${txt}" @${Math.round(r.x)},${Math.round(r.y)}]`
          })
          .join(' ')
      }, [...STUDIO_SELECTORS.modelTurnContainers])
      this.logStep('turn copy fallback->dom', turnButtonsDump.slice(0, 260), 'warn')
    } catch {
      // ignore dump error
    }

    // Fallback (c): DOM extraction without thoughts
    const domText = await this.extractFinalAnswerWithoutThoughts(page)
    return { text: domText, source: 'dom' }
  }

  /**
   * Read any visible toast / snackbar / alert text on the AI Studio page (e.g. when Run fails with 403).
   */
  private async readPageToastOrErrorText(page: Page): Promise<string> {
    try {
      return await page.evaluate(() => {
        const selectors = [
          'mat-snack-bar-container',
          'simple-snack-bar',
          '.mat-mdc-snack-bar-container',
          '.cdk-overlay-container [role="status"]',
          '.cdk-overlay-container [role="alert"]',
          '[role="alert"]',
          '.error-message',
          '.mat-mdc-snack-bar-label',
        ]
        const parts: string[] = []
        for (const sel of selectors) {
          try {
            const nodes = Array.from(document.querySelectorAll(sel))
            for (const n of nodes) {
              const el = n as HTMLElement
              const r = el.getBoundingClientRect()
              if (r.width <= 0 || r.height <= 0) continue
              const txt = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ')
              if (txt && !parts.includes(txt)) {
                parts.push(txt)
              }
            }
          } catch {
            /* ignore */
          }
        }
        return parts.join(' | ').slice(0, 500)
      })
    } catch {
      return ''
    }
  }

  /**
   * Execute a single (shortPart, movieBlock) Studio job:
   * a. Open a NEW chat on aistudio.google.com
   * b. Configure Run Settings (thinking=High, maxOutputTokens, model fallback selection if triggered)
   * c. Attach Video 1 (short part) & Video 2 (movie_360p), set start/end times + FPS=24 (verified read-back + 10s wait after Save)
   * d. Paste prompt text and check token counter BEFORE pressing Run:
   *    - If > maxInputTokens (1_048_576 - maxOutputTokens - 5_000, or user override), signal shrink_needed
   *    - Never run the shrink check after pressing Run (during generation the counter can include output tokens)
   *    - Keep the implausibly low token counter check (minimum 500 tokens/sec of video)
   *    - Wait 10s after token counter settles before pressing Run
   * e. Press Run -> capture GenerateContent network response (status + body) & page toast -> wait up to 10m -> check permission denied first (own 5-retry counter + model fallback 3.8 -> 3.7 -> 3.6 Flash) -> detect completion via STOP_GONE | HISSA_FOUND | STABLE_6S
   * f. Fetch final answer via turn "Copy as text" (or DOM fallback) -> synchronously validate with validateStudioAnswer (retry up to 3x in new chat if invalid) -> calibrate offset mode -> parseChunkMatches
   * g. Save rotated cookies/profile & recycle Playwright page in same persistent context after every N finished window jobs (default 5)
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
    const MAX_PERMISSION_RETRIES = 5
    let permissionDeniedRetries = 0
    const MAX_INVALID_RESULT_RETRIES = 3
    let invalidResultRetries = 0

    // Model fallback chain when 403 PERMISSION_DENIED occurs on Run
    const MODEL_FALLBACK_CHAIN = ['Gemini 3.8 Flash', 'Gemini 3.7 Flash', 'Gemini 3.6 Flash']
    let activeModelIndex = 0
    let activeModelName = modelName || MODEL_FALLBACK_CHAIN[0]

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.waitIfPausedOrThrowIfStopped(scope)
      const page = await this.ensurePage(username)

      try {
        // (a) Open a NEW chat on aistudio.google.com
        this.logStep('opening new chat', `${jobLabel} (attempt ${attempt}/${MAX_ATTEMPTS}, model=${activeModelName})`)
        await page.goto(STUDIO_URLS.newChat, {
          waitUntil: 'domcontentloaded',
          timeout: 45_000,
        })
        await new Promise((r) => setTimeout(r, 2500))
        await this.dismissAnyOnboardingModals(page)

        if (page.url().includes('accounts.google.com')) {
          throw new Error(
            'Google session logged out or requires verification. Open "Gemini Studio Live" -> Login Assist or log in once in the persistent Chrome profile.',
          )
        }

        // (b) Configure Run Settings (panel is already open in new chat: wait for elements, select model/fallback model, set Thinking=High)
        await this.configureRunSettings(page, { modelName: activeModelName, maxOutputTokens }, scope)

        // (c) Attach Video 1 = short part & Video 2 = movie_360p, set start/end & 24 FPS (waits 10s after each Save)
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
          await this.saveRotatedSessionFromContext(username)
          return {
            status: 'shrink_needed',
            tokenCount: tokens,
            maxInputTokens: effectiveMaxInputTokens,
          }
        }

        // Wait 10 seconds after the prompt is pasted and the token counter has settled, then press Run
        await new Promise((r) => setTimeout(r, 10_000))

        // Attach network response listener BEFORE pressing Run so we capture exact GenerateContent status + body on 403/errors
        let capturedRunError: { status: number; url: string; body: string } | null = null
        const onRunResponse = async (res: PlaywrightResponse) => {
          try {
            const url = res.url()
            const status = res.status()
            const isGenApi =
              /GenerateContent|StreamGenerateContent|MakerSuiteService|alkali|generativelanguage|batchexecute|aistudio\.google\.com\/_\//i.test(
                url,
              )
            if (!isGenApi && status < 400) return
            if (status >= 400 || /GenerateContent|MakerSuiteService|alkali/i.test(url)) {
              const text = await res.text().catch(() => '')
              if (
                status >= 400 ||
                /PERMISSION_DENIED|caller does not have permission|"error"\s*:/i.test(text)
              ) {
                const compactBody = text.replace(/\s+/g, ' ').trim().slice(0, 600)
                capturedRunError = { status, url, body: compactBody }
              }
            }
          } catch {
            /* ignore response read race */
          }
        }
        page.on('response', onRunResponse)

        const runStarted = Date.now()
        const TIMEOUT_MS = 10 * 60_000
        let rawAnswer = ''
        let lastCandidateText = ''
        let stableSeconds = 0
        let stopEverSeen = false
        let stopGoneConsecutivePolls = 0
        let doneIndicator: 'STOP_GONE' | 'HISSA_FOUND' | 'STABLE_6S' | null = null
        let permissionDeniedTriggered = false
        let transientBannerReason: string | null = null

        try {
          // (e) Press Run
          const runBtn = await findFirstVisibleLocator(page, STUDIO_SELECTORS.runButton, 4000)
          if (runBtn) {
            await runBtn.click()
          } else {
            await promptInput.press('Control+Enter')
          }

          // Poll every 1 s up to 10-min timeout.
          while (Date.now() - runStarted < TIMEOUT_MS) {
            await this.waitIfPausedOrThrowIfStopped(scope)

            // Priority 1: Check network response + page text for 403 PERMISSION_DENIED as soon as Run is pressed
            const domPermissionDenied = await page
              .evaluate(() => {
                const bodyText = document.body?.innerText || ''
                return /failed to generate content[\s\S]{0,80}permission denied|caller does not have permission/i.test(
                  bodyText,
                )
              })
              .catch(() => false)

            const netPermissionDenied =
              capturedRunError !== null &&
              (capturedRunError.status === 403 ||
                /PERMISSION_DENIED|caller does not have permission/i.test(capturedRunError.body))

            if (domPermissionDenied || netPermissionDenied) {
              // Give network response body a brief moment to settle if DOM fired first
              if (!capturedRunError) {
                await new Promise((r) => setTimeout(r, 400))
              }
              const toastText = await this.readPageToastOrErrorText(page)
              const statusLabel = capturedRunError?.status || 403
              const bodySnippet =
                capturedRunError?.body ||
                toastText ||
                'The caller does not have permission (no response body captured)'
              const exactErrLog = `ERROR [run] ${statusLabel} PERMISSION_DENIED: ${bodySnippet}${
                toastText && !bodySnippet.includes(toastText) ? ` | Toast: ${toastText}` : ''
              } (model=${activeModelName})`

              this.logStep('ERROR [run] 403 PERMISSION_DENIED', exactErrLog, 'error')
              onLog?.('error', `${exactErrLog} on ${jobLabel}`)

              permissionDeniedRetries += 1

              // Model fallback: advance to next model in MODEL_FALLBACK_CHAIN (3.8 Flash -> 3.7 Flash -> 3.6 Flash)
              const prevModel = activeModelName
              if (activeModelIndex + 1 < MODEL_FALLBACK_CHAIN.length) {
                activeModelIndex += 1
              } else {
                activeModelIndex = (activeModelIndex + 1) % MODEL_FALLBACK_CHAIN.length
              }
              activeModelName = MODEL_FALLBACK_CHAIN[activeModelIndex]

              this.logStep(
                'permission denied - retrying',
                `${jobLabel} (retry ${permissionDeniedRetries}/${MAX_PERMISSION_RETRIES}) -> model fallback: ${prevModel} -> ${activeModelName}`,
                'warn',
              )
              onLog?.(
                'warn',
                `AI Studio 403 PERMISSION_DENIED on ${jobLabel} with ${prevModel} (retry ${permissionDeniedRetries}/${MAX_PERMISSION_RETRIES}) — switching model to "${activeModelName}" and retrying in a new chat`,
              )

              if (permissionDeniedRetries > MAX_PERMISSION_RETRIES) {
                throw new Error(
                  `PERMISSION_DENIED_EXHAUSTED: ${exactErrLog} after ${MAX_PERMISSION_RETRIES} permission retries on ${jobLabel}`,
                )
              }
              await new Promise((r) => setTimeout(r, 5000))
              permissionDeniedTriggered = true
              break
            }

            const elapsed = Math.floor((Date.now() - runStarted) / 1000)
            const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
            const ss = String(elapsed % 60).padStart(2, '0')
            this.logStep(`running ${mm}:${ss}`, `${jobLabel} [${activeModelName}]`)

            // Error/quota/alert banner detection (real alert/banner containers + specific phrases only)
            const errBannerText = await page.evaluate((sels) => {
              const strictRegex =
                /(quota\s+exceeded|resource[_\s]+exhausted|rate\s+limit|try\s+again\s+later|prohibited_content|blocked\s+due\s+to\s+safety|internal\s+error|something\s+went\s+wrong|failed\s+to\s+generate)/i
              for (const s of sels) {
                if (s.includes(':has-text(')) continue
                try {
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
                } catch {
                  // ignore invalid selector
                }
              }
              return null
            }, [...STUDIO_SELECTORS.errorBanners])

            if (errBannerText) {
              const netDetail = capturedRunError
                ? ` | HTTP ${capturedRunError.status}: ${capturedRunError.body}`
                : ''
              this.logStep('error banner', `${errBannerText.slice(0, 180)}${netDetail}`, 'warn')
              onLog?.(
                'warn',
                `Matched AI Studio error banner on ${jobLabel}: "${errBannerText.slice(0, 200)}"${netDetail}`,
              )
              if (/(prohibited_content|blocked\s+due\s+to\s+safety)/i.test(errBannerText) && !sanitized) {
                onLog?.(
                  'warn',
                  `Studio flagged content policy on ${jobLabel} — retrying once with sanitized neutral prompt`,
                )
                return this.runWindowJob({ ...params, sanitized: true })
              }
              if (/(internal\s+error|something\s+went\s+wrong|failed\s+to\s+generate)/i.test(errBannerText)) {
                transientBannerReason = `error_banner:${errBannerText.slice(0, 80)}`
                break
              }
              throw new Error(`AI Studio banner error: ${errBannerText.slice(0, 180)}${netDetail}`)
            }

            const stopLoc = await findFirstVisibleLocator(page, STUDIO_SELECTORS.stopButton, 100)
            const stopVisible = Boolean(stopLoc)
            if (stopVisible) {
              stopEverSeen = true
            }

            if (elapsed >= 2) {
              const spinnerVisible = await this.isThinkingOrRunningSpinnerVisible(page)
              const candidateText = await this.extractFinalAnswerWithoutThoughts(page)

              if (candidateText.length > 0) {
                if (candidateText === lastCandidateText) {
                  stableSeconds += 1
                } else {
                  lastCandidateText = candidateText
                  stableSeconds = 1
                }
              } else {
                stableSeconds = 0
              }

              if (stopEverSeen && !stopVisible && !spinnerVisible) {
                stopGoneConsecutivePolls += 1
              } else {
                stopGoneConsecutivePolls = 0
              }

              // Indicator A: STOP_GONE (Stop was seen at least once, now Stop + scoped spinner are gone for 2 consecutive polls)
              if (stopEverSeen && !stopVisible && !spinnerVisible && stopGoneConsecutivePolls >= 2) {
                doneIndicator = 'STOP_GONE'
              }
              // Indicator B: HISSA_FOUND (both HISSA 1 and HISSA 2 present in answer text, and Stop is gone OR text unchanged for 3s)
              else if (
                /HISSA\s*1\b/i.test(candidateText) &&
                /HISSA\s*2\b/i.test(candidateText) &&
                (!stopVisible || stableSeconds >= 3)
              ) {
                doneIndicator = 'HISSA_FOUND'
              }
              // Indicator C: STABLE_6S (answer text is non-empty and unchanged for 6 consecutive seconds)
              else if (candidateText.length > 0 && stableSeconds >= 6) {
                doneIndicator = 'STABLE_6S'
              }

              if (doneIndicator) {
                this.logStep(`done by ${doneIndicator}`, `${jobLabel} [${activeModelName}]`, 'success')
                break
              }
            }

            await new Promise((r) => setTimeout(r, 1000))
          }
        } finally {
          page.off('response', onRunResponse)
        }

        if (permissionDeniedTriggered) {
          await this.saveRotatedSessionFromContext(username)
          // Do NOT consume normal MAX_ATTEMPTS = 3; open a new chat at the top of the loop and redo the same job
          attempt -= 1
          continue
        }

        // CHANGE 3 & CHANGE 4 & CHANGE 5:
        // If a transient internal-error banner broke the loop, or after done/timeout, fetch and validate immediately.
        // On timeout (doneIndicator === null), still attempt one fetch + validate in case the answer finished on screen.
        let validationReason = transientBannerReason || ''
        let fetchedSource: 'clipboard' | 'dom' = 'dom'
        let validation: StudioValidationResult | null = null

        if (!transientBannerReason) {
          const fetched = await this.fetchStudioResultFromTurnOrFallback(page)
          fetchedSource = fetched.source
          const answerText = fetched.text || lastCandidateText

          // Wrap validation in try/catch so internal validator exceptions never cause a failure/retry
          try {
            validation = validateStudioAnswer(answerText, {
              shortWindowSec: shortEndSec - shortStartSec,
            })
          } catch (valErr) {
            const valErrMsg = valErr instanceof Error ? valErr.message : String(valErr)
            this.logStep(
              'validate error',
              `ERROR [validate] validateStudioAnswer threw: ${valErrMsg} -> keeping answer as DONE (validation skipped)`,
              'warn',
            )
            onLog?.(
              'warn',
              `ERROR [validate] Studio validator exception: ${valErrMsg}. Marking DONE (validation skipped) and accepting answer.`,
            )
            rawAnswer = answerText
          }

          if (validation) {
            if (validation.ok) {
              rawAnswer = validation.cleanedText
              if (validation.stats.softWarning) {
                this.logStep('result coverage note', validation.stats.softWarning, 'warn')
              }
              this.logStep(
                'SUCCESS [validate]',
                `result check OK (HISSA 1 + HISSA 2, ${validation.stats.totalValidHissa2Lines} lines: ${validation.stats.matchLineCount} matches, ${validation.stats.notFoundLineCount} notFound, source=${fetchedSource})`,
                'success',
              )
              onLog?.(
                'success',
                `SUCCESS [validate] ${jobLabel}: valid result (${validation.stats.totalValidHissa2Lines} lines: ${validation.stats.matchLineCount} matches, ${validation.stats.notFoundLineCount} not found, source=${fetchedSource})`,
              )
            } else {
              // If doneIndicator was HISSA_FOUND, both HISSA 1 and HISSA 2 were detected on screen!
              // Preserve the result instead of throwing away and retrying
              if (
                doneIndicator === 'HISSA_FOUND' &&
                /HISSA\s*1\b/i.test(answerText) &&
                /HISSA\s*2\b/i.test(answerText)
              ) {
                this.logStep(
                  'HISSA_FOUND preserved',
                  `Validation reason=${validation.reason}, but HISSA_FOUND was detected on screen. Marking DONE (validation skipped).`,
                  'warn',
                )
                onLog?.(
                  'warn',
                  `[validate] Validation flagged reason=${validation.reason}, but HISSA_FOUND was detected on screen. Marking DONE (validation skipped) and accepting answer (${answerText.length} chars).`,
                )
                rawAnswer = answerText
              } else {
                validationReason =
                  !doneIndicator && validation.reason === 'empty' ? 'timeout_10m' : validation.reason
              }
            }
          }
        }

        if (!rawAnswer) {
          invalidResultRetries += 1
          const badReason = validationReason || 'empty'
          this.logStep(
            `RETRY [runWindowJob] (${invalidResultRetries}/${MAX_INVALID_RESULT_RETRIES})`,
            `result BAD: ${badReason} -> naya chat, same window retry`,
            'warn',
          )
          onLog?.(
            'warn',
            `RETRY [runWindowJob] Studio result BAD (${badReason}) on ${jobLabel} — opening new chat and retrying same window (${invalidResultRetries}/${MAX_INVALID_RESULT_RETRIES})`,
          )
          if (invalidResultRetries > MAX_INVALID_RESULT_RETRIES) {
            throw new Error(`INVALID_RESULT_EXHAUSTED: ${badReason}`)
          }
          // Immediate retry in a new chat with zero backoff wait and without consuming MAX_ATTEMPTS
          attempt -= 1
          continue
        }

        // (f) Calibrate offset mode (relative 0:00 vs absolute startSec) and parse via parseChunkMatches!
        const calibrated = await this.calibrateAndParseMatches({
          username,
          rawText: rawAnswer,
          shortStartSec,
          shortEndSec,
          movieStartSec,
          movieEndSec,
          modelName: activeModelName,
          onLog,
        })

        // Item 5: Page recycling after every N finished window jobs (success or failed) + rotated cookie persistence
        await this.recordFinishedWindowJobAndMaybeRecyclePage(
          username,
          effectiveRecycleInterval,
          onLog,
        )

        // Item 4: Token-report fallback — when Studio counter is not readable, estimate with 1940 tokens/sec (calibrated: 930K / 480 s).
        // The real counter always wins when readable.
        const fallbackTokens24Fps = Math.round(totalVideoSec * 1940)
        const matchSummary =
          calibrated.matches.length > 0
            ? `found ${calibrated.matches.length} matches`
            : 'not found (no matches in this window)'

        this.logStep('SUCCESS [runWindowJob]', `${jobLabel} [${activeModelName}]: ${matchSummary}`, 'success')
        onLog?.(
          'success',
          `SUCCESS [runWindowJob] ${jobLabel} [${activeModelName}]: ${matchSummary} (${tokens || fallbackTokens24Fps} tokens)`,
        )

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

        // User pause/stop must not be logged as error, use "STOPPED BY USER"
        const isUserStopped =
          msg === 'STOPPED BY USER' ||
          /stopped by user/i.test(msg) ||
          this.isStopping(scope)

        if (isUserStopped) {
          this.logStep('STOPPED BY USER', jobLabel, 'info')
          onLog?.('info', `STOPPED BY USER on ${jobLabel}`)
          throw new Error('STOPPED BY USER')
        }

        if (
          msg.includes('PERMISSION_DENIED_EXHAUSTED:') ||
          msg.includes('INVALID_RESULT_EXHAUSTED:')
        ) {
          await this.recordFinishedWindowJobAndMaybeRecyclePage(
            username,
            effectiveRecycleInterval,
            onLog,
          )
          throw err
        }
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
          `RETRY [runWindowJob] (${attempt}/${MAX_ATTEMPTS})`,
          `ERROR: ${msg.slice(0, 100)} — waiting ${backoffSec}s`,
          'warn',
        )
        onLog?.(
          'warn',
          `RETRY [runWindowJob] Studio job ${jobLabel} attempt ${attempt}/${MAX_ATTEMPTS} error: ${msg} — retrying in ${backoffSec}s...`,
        )
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
