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
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    }
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  /**
   * Parse a clock/time string read back from Studio's video settings input
   * (e.g. "05:00", "1:05:00", "300", "05m 00s") into seconds.
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

    // e.g. "5m 30s" or "120s"
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
  /**
   * Problem 2(d): Dump the Run Settings panel HTML + controls to the step log when
   * model list / thinking level dropdown selectors are not found or verification fails.
   */
  private async dumpRunSettingsPanelDiagnostics(page: Page, reason: string): Promise<void> {
    try {
      const dump = await page.evaluate(() => {
        const panelCandidates = Array.from(
          document.querySelectorAll(
            'ms-run-settings, [class*="run-settings" i], aside, .right-side-panel, [data-test-id*="run-settings" i]',
          ),
        )
        const panelEl =
          panelCandidates.find((el) => (el as HTMLElement).offsetParent !== null) ||
          panelCandidates[0] ||
          null

        const overlayPanes = Array.from(document.querySelectorAll('.cdk-overlay-pane, [role="listbox"], [role="menu"], [role="dialog"]'))
          .filter((el) => (el.textContent || '').trim().length > 0)
          .map((el) => el.outerHTML.slice(0, 1500))
          .join(' || ')

        const panelHtml = panelEl
          ? panelEl.outerHTML.slice(0, 3000)
          : `No ms-run-settings panel found. Body snippet: ${(document.body.innerText || '').slice(0, 800)}`

        const controls = Array.from(
          (panelEl || document.body).querySelectorAll(
            'button, mat-select, [role="combobox"], [role="listbox"], [role="option"], mat-option, input',
          ),
        )
          .slice(0, 40)
          .map((c) => {
            const tag = c.tagName.toLowerCase()
            const aria = c.getAttribute('aria-label') || ''
            const role = c.getAttribute('role') || ''
            const cls = (c.getAttribute('class') || '').slice(0, 60)
            const txt = ((c as HTMLElement).innerText || c.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80)
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
   * Read the currently visible model card text at the top of the Run Settings panel.
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

        for (const sel of triggerSels) {
          const nodes = Array.from(document.querySelectorAll(sel))
          for (const node of nodes) {
            if (!isVisible(node)) continue
            const t = (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ')
            if (t && /gemini/i.test(t)) return t
          }
        }

        // Fallback: search inside the Run Settings panel for the top card/button showing "Gemini ..."
        const panelRoot =
          document.querySelector('ms-run-settings, [class*="run-settings" i], aside') || document.body
        const all = Array.from(panelRoot.querySelectorAll('ms-model-selector, button, a, [role="button"], div, span'))
        for (const node of all) {
          if (!isVisible(node)) continue
          const r = node.getBoundingClientRect()
          if (r.height > 140 || r.width > 550) continue
          const t = (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ')
          if (/^gemini\s+\d+(\.\d+)?/i.test(t) || /\bgemini\s+3\.8\b/i.test(t) || /\bgemini\s+2\.5\b/i.test(t)) {
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

        // Row-scoped lookup: find the compact row containing "Thinking level" and read its dropdown/button value
        const all = Array.from(document.body.querySelectorAll('*'))
        const labelNodes = all.filter((el) => {
          if (!isVisible(el)) return false
          const t = ((el as HTMLElement).innerText || el.textContent || '').trim()
          return /^thinking\s+level$/i.test(t)
        })

        for (const lbl of labelNodes) {
          let row: Element | null = lbl.parentElement
          for (let depth = 0; depth < 5 && row; depth++) {
            const r = row.getBoundingClientRect()
            if (r.height <= 140 && r.width <= 600) {
              const ctrl = row.querySelector(
                'mat-select, [role="combobox"], button[aria-haspopup], select, .mat-mdc-select-value, button',
              ) as HTMLElement | null
              if (ctrl && isVisible(ctrl)) {
                const val = (ctrl.innerText || ctrl.textContent || (ctrl as HTMLInputElement).value || '')
                  .trim()
                  .replace(/\s+/g, ' ')
                if (val && !/^thinking\s+level$/i.test(val)) {
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
            const t = ((el as HTMLElement).innerText || el.textContent || '').trim()
            return re.test(t) && t.length <= 40
          })

          for (const leaf of labelLeaves) {
            let row: Element | null = leaf.parentElement
            for (let depth = 0; depth < 5 && row; depth++) {
              const r = row.getBoundingClientRect()
              if (r.height >= 18 && r.height <= 150 && r.width <= 600) {
                const ctrl = row.querySelector(
                  'mat-select, [role="combobox"], button[aria-haspopup], select, button:not([aria-label*="info" i]):not([aria-label*="help" i])',
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
   * Step (b): Configure model name (default 'Gemini 3.8 Pro', fallback to first '3.8' entry),
   * Thinking level = High, temperature = 0, max output tokens, media resolution = Low,
   * and safety settings all OFF.
   * Reads back visible model card text and thinking level dropdown text to verify, retries once,
   * dumps panel HTML if selectors are missing, and THROWS if either fails verification.
   */
  private async configureRunSettings(
    page: Page,
    config: { modelName: string; maxOutputTokens: number },
    scope?: { scanId?: string | null; username?: string | null },
  ) {
    await this.waitIfPausedOrThrowIfStopped(scope)

    // 0. Ensure Run Settings panel is open (button[aria-label="Toggle run settings panel"], icon "tune")
    const isPanelAlreadyOpen = await page
      .evaluate(() => {
        const panel = document.querySelector('ms-run-settings, [class*="run-settings" i]') as HTMLElement | null
        if (panel && panel.getBoundingClientRect().width > 40) return true
        const bodyText = document.body.innerText || ''
        return /thinking\s+level/i.test(bodyText) && /temperature/i.test(bodyText)
      })
      .catch(() => false)

    if (!isPanelAlreadyOpen) {
      const toggle = await findFirstVisibleLocator(page, STUDIO_SELECTORS.runSettingsToggle, 2500)
      if (toggle) {
        await toggle.click().catch(() => {})
        await new Promise((r) => setTimeout(r, 500))
      } else {
        await this.dumpRunSettingsPanelDiagnostics(page, 'Run settings toggle button not found')
      }
    }

    // 1. Select Model (prefer configured studioModelName, default 'Gemini 3.8 Pro'; fallback to 'Gemini 3.8 Pro' -> 'Gemini 3.8 Flash' -> first '3.8' entry)
    const targetModel = (config.modelName || 'Gemini 3.8 Pro').trim()
    let verifiedModelText = ''
    let modelConfigError = ''

    for (let modelAttempt = 1; modelAttempt <= 2; modelAttempt++) {
      await this.waitIfPausedOrThrowIfStopped(scope)
      modelConfigError = ''

      const currentCardText = await this.readVisibleModelCardText(page)
      const targetLower = targetModel.toLowerCase()

      // Check if current model card already matches the exact requested model (e.g. "Gemini 3.8 Pro")
      if (currentCardText && currentCardText.toLowerCase().includes(targetLower)) {
        verifiedModelText = currentCardText
        break
      }

      // Click the model card at the top of the Run Settings panel (or its 3-dot / trigger button) to open the model list
      let clickedTrigger = false
      const triggerLoc = await findFirstVisibleLocator(page, STUDIO_SELECTORS.modelSelectorTrigger, 2000)
      if (triggerLoc) {
        await triggerLoc.click().catch(() => {})
        clickedTrigger = true
      } else {
        // Fallback: find the visible model card / button at top of Run Settings panel showing "Gemini ..."
        const markedCard = await page
          .evaluate(() => {
            document
              .querySelectorAll('[data-cmt-model-card]')
              .forEach((el) => el.removeAttribute('data-cmt-model-card'))
            const root =
              document.querySelector('ms-run-settings, [class*="run-settings" i], aside') || document.body
            const candidates = Array.from(
              root.querySelectorAll('ms-model-selector, button, [role="button"], [role="combobox"], div'),
            )
            for (const c of candidates) {
              const el = c as HTMLElement
              const r = el.getBoundingClientRect()
              if (r.width < 40 || r.width > 550 || r.height < 20 || r.height > 130) continue
              const t = (el.innerText || el.textContent || '').trim()
              if (/gemini\s+\d+(\.\d+)?/i.test(t)) {
                // Prefer a button inside or the card itself
                const btn = el.querySelector('button, [role="button"]') as HTMLElement | null
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
            await fallbackCard.click().catch(() => {})
            clickedTrigger = true
          }
        }
      }

      await new Promise((r) => setTimeout(r, 500))

      // Check if model list options are visible; if not, try clicking any 3-dot / more / chevron button on the model card
      const countVisibleOptions = async () =>
        page
          .locator(
            'mat-option, [role="option"], [role="menuitem"], ms-model-option, .model-option, .cdk-overlay-pane [class*="model" i]',
          )
          .count()
          .catch(() => 0)

      if ((await countVisibleOptions()) === 0) {
        const moreClicked = await page
          .evaluate(() => {
            const root =
              document.querySelector('ms-model-selector, [data-cmt-model-card="true"], ms-run-settings') ||
              document.body
            const btns = Array.from(root.querySelectorAll('button, [role="button"]'))
            for (const b of btns) {
              const el = b as HTMLElement
              const r = el.getBoundingClientRect()
              if (r.width <= 0 || r.height <= 0 || r.top > 300) continue
              const meta = (
                (el.getAttribute('aria-label') || '') +
                ' ' +
                (el.getAttribute('mattooltip') || '') +
                ' ' +
                (el.textContent || '')
              ).toLowerCase()
              if (/model|more_vert|more_horiz|expand_more|arrow_drop_down|chevron|switch|change/i.test(meta)) {
                el.click()
                return true
              }
            }
            return false
          })
          .catch(() => false)
        if (moreClicked) {
          clickedTrigger = true
          await new Promise((r) => setTimeout(r, 500))
        }
      }

      if (!clickedTrigger) {
        await this.dumpRunSettingsPanelDiagnostics(page, `model selector trigger not found (attempt ${modelAttempt}/2)`)
      }

      // Inspect options in the opened model list and click the best match:
      // 1) exact/substring match for targetModel (e.g. "Gemini 3.8 Pro")
      // 2) "Gemini 3.8 Pro"
      // 3) "Gemini 3.8 Flash"
      // 4) first entry containing "3.8"
      const pickResult = await page
        .evaluate((desiredModel) => {
          const isVisible = (el: Element): el is HTMLElement => {
            const h = el as HTMLElement
            const r = h.getBoundingClientRect()
            return r.width > 0 && r.height > 0 && window.getComputedStyle(h).visibility !== 'hidden'
          }

          document
            .querySelectorAll('[data-cmt-picked-model]')
            .forEach((el) => el.removeAttribute('data-cmt-picked-model'))

          const rawOptions = Array.from(
            document.querySelectorAll(
              'mat-option, [role="option"], [role="menuitem"], ms-model-option, .model-option, .cdk-overlay-pane button, .cdk-overlay-pane [role="button"], .cdk-overlay-pane div[class*="option" i], .cdk-overlay-pane div[class*="item" i], .cdk-overlay-pane div[class*="card" i]',
            ),
          ).filter((el) => {
            if (!isVisible(el)) return false
            const t = ((el as HTMLElement).innerText || el.textContent || '').trim()
            return t.length > 0 && t.length < 300 && (/gemini/i.test(t) || /3\.8/i.test(t) || /2\.5/i.test(t))
          })

          // Keep minimal option rows so we don't pick a wrapper div containing all options
          const options = rawOptions.filter(
            (el) => !rawOptions.some((child) => child !== el && el.contains(child)),
          )

          if (options.length === 0) {
            return { foundList: false, pickedText: '', usedFallback: false, available: [] as string[] }
          }

          const entries = options.map((el) => ({
            el: el as HTMLElement,
            text: ((el as HTMLElement).innerText || el.textContent || '').trim().replace(/\s+/g, ' '),
          }))

          const desiredLower = desiredModel.toLowerCase()
          let chosen = entries.find((e) => e.text.toLowerCase().includes(desiredLower))
          let usedFallback = false

          if (!chosen) {
            usedFallback = true
            chosen =
              entries.find((e) => /gemini\s*3\.8\s*pro/i.test(e.text)) ||
              entries.find((e) => /3\.8\s*pro/i.test(e.text)) ||
              entries.find((e) => /gemini\s*3\.8\s*flash/i.test(e.text)) ||
              entries.find((e) => /3\.8/i.test(e.text)) ||
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

      let expectedSubstringAfterPick = targetLower

      if (pickResult.pickedText) {
        const pickedLoc = page.locator('[data-cmt-picked-model="true"]').first()
        if ((await pickedLoc.count()) > 0) {
          await pickedLoc.click().catch(() => {})
        }
        if (pickResult.usedFallback) {
          this.logStep(
            'model fallback',
            `"${targetModel}" not in list; selected "${pickResult.pickedText}"`,
            'info',
          )
          expectedSubstringAfterPick = /3\.8\s*pro/i.test(pickResult.pickedText)
            ? '3.8 pro'
            : /3\.8\s*flash/i.test(pickResult.pickedText)
              ? '3.8 flash'
              : '3.8'
        }
        await new Promise((r) => setTimeout(r, 450))
        // Close any leftover dropdown backdrop
        await page.keyboard.press('Escape').catch(() => {})
        await new Promise((r) => setTimeout(r, 200))
      } else {
        await this.dumpRunSettingsPanelDiagnostics(
          page,
          `model option "${targetModel}" (or "3.8") not found in model list (foundList=${pickResult.foundList}, available=${pickResult.available.join(' | ') || 'none'})`,
        )
        await page.keyboard.press('Escape').catch(() => {})
        // If the model list could not be opened or did not contain targetModel, only accept if the visible model card already shows a 3.8 model when targetModel wasn't available
        if (pickResult.foundList && !pickResult.available.some((a) => a.toLowerCase().includes(targetLower)) && /3\.8/i.test(currentCardText)) {
          this.logStep(
            'model fallback',
            `"${targetModel}" not in list; keeping visible 3.8 model "${currentCardText}"`,
            'info',
          )
          expectedSubstringAfterPick = '3.8'
        }
      }

      // READ BACK the visible model card text from the UI
      const readBackModel = await this.readVisibleModelCardText(page)
      const readLower = readBackModel.toLowerCase()

      const modelMatched =
        Boolean(readBackModel) &&
        (readLower.includes(expectedSubstringAfterPick) ||
          (expectedSubstringAfterPick.includes('3.8') && readLower.includes('3.8') && pickResult.usedFallback))

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

    // 2. Set Temperature = 0
    try {
      const tempInput = await findFirstVisibleLocator(page, STUDIO_SELECTORS.temperatureInput, 2000)
      if (tempInput) {
        await tempInput.click({ clickCount: 3 })
        await tempInput.fill('0')
        await tempInput.press('Enter')
      }
    } catch {
      /* ignore */
    }

    // 3. Set Media Resolution = Low (~65 tokens/frame) using row-scoped selector so it never hits Thinking level
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
          await resSelect.click()
          await new Promise((r) => setTimeout(r, 300))
          const lowOpt = page
            .locator('mat-option:has-text("Low"), [role="option"]:has-text("Low"), [role="menuitem"]:has-text("Low")')
            .first()
          if ((await lowOpt.count()) > 0) {
            await lowOpt.click()
          } else {
            await page.keyboard.press('Escape')
          }
          await new Promise((r) => setTimeout(r, 250))
        }
      }
    } catch {
      /* ignore */
    }

    // 4. Set "Thinking level" dropdown to High & READ BACK visible value (retry once, dump panel HTML, then THROW)
    let verifiedThinkingText = ''
    let thinkingConfigError = ''

    for (let thinkAttempt = 1; thinkAttempt <= 2; thinkAttempt++) {
      await this.waitIfPausedOrThrowIfStopped(scope)
      thinkingConfigError = ''

      let thinkSelect = await findFirstVisibleLocator(page, STUDIO_SELECTORS.thinkingLevelSelect, 1500)
      if (!thinkSelect) {
        const markedThink = await this.markRowDropdownByLabel(
          page,
          '^thinking\\s+(level|budget)$',
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
            await page.keyboard.press('Escape').catch(() => {})
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

    // 5. Open Advanced Settings if collapsed -> Max Output Tokens + Safety Settings all OFF
    try {
      const advBtn = await findFirstVisibleLocator(page, STUDIO_SELECTORS.advancedSettingsToggle, 1200)
      if (advBtn) {
        const expanded = await advBtn.getAttribute('aria-expanded')
        if (expanded === 'false') {
          await advBtn.click()
          await new Promise((r) => setTimeout(r, 300))
        }
      }

      const maxOutInput = await findFirstVisibleLocator(page, STUDIO_SELECTORS.maxOutputTokensInput, 1500)
      if (maxOutInput) {
        await maxOutInput.click({ clickCount: 3 })
        await maxOutInput.fill(String(config.maxOutputTokens || 65536))
        await maxOutInput.press('Enter')
      }

      const safetyTrigger = await findFirstVisibleLocator(page, STUDIO_SELECTORS.safetySettingsTrigger, 1500)
      if (safetyTrigger) {
        await safetyTrigger.click()
        await new Promise((r) => setTimeout(r, 400))
        // Set all safety sliders in modal to minimum (0 = Off / Block none)
        const sliders = page.locator(STUDIO_SELECTORS.safetySliders.join(', '))
        const sliderCount = await sliders.count()
        for (let i = 0; i < sliderCount; i++) {
          const sl = sliders.nth(i)
          await sl.fill('0').catch(async () => {
            await sl.focus()
            await page.keyboard.press('Home')
          })
        }
        const closeBtn = await findFirstVisibleLocator(page, STUDIO_SELECTORS.safetyModalClose, 1500)
        if (closeBtn) {
          await closeBtn.click()
        } else {
          await page.keyboard.press('Escape')
        }
        await new Promise((r) => setTimeout(r, 250))
      }
    } catch {
      /* ignore */
    }

    // Final read-back verification before logging success
    const finalModelReadBack = (await this.readVisibleModelCardText(page)) || verifiedModelText
    const finalThinkingReadBack = (await this.readVisibleThinkingLevelText(page)) || verifiedThinkingText
    if (!/\bhigh\b/i.test(finalThinkingReadBack)) {
      await this.dumpRunSettingsPanelDiagnostics(
        page,
        `final thinking read-back check failed: "${finalThinkingReadBack}"`,
      )
      throw new Error(`Studio thinking level config failed: expected "High", read back "${finalThinkingReadBack || 'empty'}"`)
    }

    this.logStep(
      'model set',
      `model="${finalModelReadBack}" · thinking="${finalThinkingReadBack}" · temp=0 · mediaRes=Low · safety=OFF`,
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
   * FIX 1: Attach a YouTube link or Drive file or local file as a video asset in the prompt,
   * verify media chip count increased, verify the added chip matches the intended video,
   * configure Start Time, End Time, and FPS = 24 via the Video Settings dialog,
   * and READ BACK all three values to confirm they stuck (retrying the dialog once, then THROWING).
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

    // FIX 1a: Wait for the new video chip to appear via combined locator, and dump diagnostics BEFORE throwing if chip count did not increase
    const waitDeadline = Date.now() + 90_000
    let chipCount = chipsBefore
    while (Date.now() < waitDeadline) {
      await this.waitIfPausedOrThrowIfStopped(scope)
      await this.syncFallbackMediaChips(page)
      chipCount = await chipsLocator.count()
      if (chipCount > chipsBefore) break
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
    // set start / end / FPS, and READ BACK all three values.
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
      await new Promise((r) => setTimeout(r, 600))

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
        await startInput.dispatchEvent('change').catch(() => {})

        await endInput.click({ clickCount: 3 })
        await endInput.fill(endStr)
        await endInput.dispatchEvent('change').catch(() => {})

        await fpsInput.click({ clickCount: 3 })
        await fpsInput.fill(String(fps))
        await fpsInput.dispatchEvent('change').catch(() => {})
        await fpsInput.press('Tab').catch(() => {})
        await new Promise((r) => setTimeout(r, 250))

        // Read back the three values from the dialog before closing
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

      // Close/save the dialog
      const saveBtn = await findFirstVisibleLocator(page, STUDIO_SELECTORS.videoSettingsSaveButton, 1500)
      if (saveBtn) {
        await saveBtn.click().catch(() => {})
      } else {
        await page.keyboard.press('Escape').catch(() => {})
      }
      await new Promise((r) => setTimeout(r, 500))

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
   * Read AI Studio's token counter from the DOM (e.g. "742,110 / 1,048,576 tokens").
   */
  public async readStudioTokenCount(page: Page): Promise<number | null> {
    try {
      const count = await page.evaluate(() => {
        const bodyText = document.body.innerText || ''
        // Pattern 1: "742,110 / 1,048,576 tokens" or "742,110 / 1,000,000"
        const m1 = bodyText.match(/([\d,]{3,})\s*\/\s*[\d,]+\s*tokens?/i)
        if (m1) {
          const n = parseInt(m1[1].replace(/,/g, ''), 10)
          if (Number.isFinite(n)) return n
        }
        // Pattern 2: "742,110 tokens"
        const m2 = bodyText.match(/([\d,]{3,})\s*tokens?/i)
        if (m2) {
          const n = parseInt(m2[1].replace(/,/g, ''), 10)
          if (Number.isFinite(n)) return n
        }
        return null
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
