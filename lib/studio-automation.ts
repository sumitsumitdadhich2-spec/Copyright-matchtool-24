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
}

const VIEWPORT = { width: 1366, height: 840 }

class StudioBrowserController {
  private context: BrowserContext | null = null
  private page: Page | null = null
  private launching: Promise<Page> | null = null
  private paused = false
  private stopRequested = false
  private assistMode = false
  private currentStep = 'idle'
  private scanId: string | null = null
  private jobLabel: string | null = null
  private tokenCount: number | null = null
  private jobStartedAt: number | null = null
  private lastScreenshotB64: string | null = null
  private lastScreenshotAt: number | null = null
  private logs: StudioStepLog[] = []
  private lastInjectedCookieUser: string | null = null

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

  public setJobContext(scanId: string | null, jobLabel: string | null) {
    this.scanId = scanId
    this.jobLabel = jobLabel
    this.jobStartedAt = scanId ? Date.now() : null
    if (!scanId) {
      this.tokenCount = null
      this.currentStep = 'idle'
    }
  }

  public setPaused(val: boolean) {
    this.paused = val
    this.logStep(val ? 'paused' : 'resumed', val ? 'User paused Studio automation' : 'User resumed Studio automation', 'warn')
  }

  public isPaused(): boolean {
    return this.paused
  }

  public requestStop() {
    this.stopRequested = true
    this.paused = false
    this.logStep('stopping', 'Stop requested by user', 'warn')
  }

  public clearStop() {
    this.stopRequested = false
  }

  public isStopping(): boolean {
    return this.stopRequested
  }

  public setAssistMode(val: boolean) {
    this.assistMode = val
    this.logStep(val ? 'login assist ON' : 'login assist OFF', undefined, 'info')
  }

  public async waitIfPausedOrThrowIfStopped() {
    while (this.paused && !this.stopRequested) {
      await new Promise((r) => setTimeout(r, 400))
    }
    if (this.stopRequested) {
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

  public async getSnapshot(captureFresh = true): Promise<StudioLiveSnapshot> {
    if (captureFresh && this.page && !this.page.isClosed()) {
      const now = Date.now()
      if (!this.lastScreenshotAt || now - this.lastScreenshotAt >= 750) {
        try {
          const buf = await this.page.screenshot({
            type: 'jpeg',
            quality: 62,
            timeout: 2500,
          })
          this.lastScreenshotB64 = buf.toString('base64')
          this.lastScreenshotAt = now
        } catch {
          /* ignore screenshot race while navigating */
        }
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
   * Step (b): Configure model name, temperature = 0, thinking level = High,
   * max output tokens, media resolution (~65 tokens/frame = Low), and safety settings all OFF.
   */
  private async configureRunSettings(
    page: Page,
    config: { modelName: string; maxOutputTokens: number },
  ) {
    await this.waitIfPausedOrThrowIfStopped()

    // Ensure Run Settings panel is open
    const tempLocCheck = await findFirstVisibleLocator(page, STUDIO_SELECTORS.temperatureInput, 1500)
    if (!tempLocCheck) {
      const toggle = await findFirstVisibleLocator(page, STUDIO_SELECTORS.runSettingsToggle, 1500)
      if (toggle) {
        await toggle.click().catch(() => {})
        await new Promise((r) => setTimeout(r, 400))
      }
    }

    // 1. Select Model by name
    const targetModel = config.modelName.trim()
    if (targetModel) {
      try {
        const trigger = await findFirstVisibleLocator(page, STUDIO_SELECTORS.modelSelectorTrigger, 2500)
        if (trigger) {
          const currentText = (await trigger.innerText().catch(() => '')).trim()
          if (!currentText.toLowerCase().includes(targetModel.toLowerCase())) {
            await trigger.click()
            await new Promise((r) => setTimeout(r, 400))
            const searchInput = await findFirstVisibleLocator(page, STUDIO_SELECTORS.modelSearchInput, 1200)
            if (searchInput) {
              await searchInput.fill(targetModel)
              await new Promise((r) => setTimeout(r, 300))
            }
            const opt = page
              .locator(`mat-option:has-text("${targetModel}"), [role="option"]:has-text("${targetModel}"), .model-option:has-text("${targetModel}")`)
              .first()
            if ((await opt.count()) > 0) {
              await opt.click()
              await new Promise((r) => setTimeout(r, 350))
            } else {
              await page.keyboard.press('Escape')
            }
          }
        }
      } catch {
        /* continue with default selected model */
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

    // 3. Thinking Level = High
    try {
      const thinkSelect = await findFirstVisibleLocator(page, STUDIO_SELECTORS.thinkingLevelSelect, 1500)
      if (thinkSelect) {
        await thinkSelect.click()
        await new Promise((r) => setTimeout(r, 250))
        const highOpt = page.locator('mat-option:has-text("High"), [role="option"]:has-text("High")').first()
        if ((await highOpt.count()) > 0) {
          await highOpt.click()
        } else {
          await page.keyboard.press('Escape')
        }
      }
    } catch {
      /* ignore */
    }

    // 4. Media Resolution = Low (~65 tokens/frame, matching API MEDIA_RESOLUTION_LOW)
    try {
      const resSelect = await findFirstVisibleLocator(page, STUDIO_SELECTORS.mediaResolutionSelect, 1500)
      if (resSelect) {
        await resSelect.click()
        await new Promise((r) => setTimeout(r, 250))
        const lowOpt = page.locator('mat-option:has-text("Low"), [role="option"]:has-text("Low")').first()
        if ((await lowOpt.count()) > 0) {
          await lowOpt.click()
        } else {
          await page.keyboard.press('Escape')
        }
      }
    } catch {
      /* ignore */
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

    this.logStep('model set', `${targetModel || 'Default'} · temp=0 · thinking=High · mediaRes=Low · safety=OFF`, 'success')
  }

  /**
   * Attach a YouTube link or Drive file or local file as a video asset in the prompt,
   * and configure its Start Time, End Time, and FPS = 24 via the Video Settings dialog.
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
    },
  ) {
    await this.waitIfPausedOrThrowIfStopped()
    const { label, youtubeUrl, driveFileName, localFilePath, startSec, endSec, fps } = params

    const chipsBefore = await page.locator(STUDIO_SELECTORS.videoMediaChips.join(', ')).count()

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

    // Wait for the new video chip to appear and finish tokenizing/loading
    const waitDeadline = Date.now() + 90_000
    let chipCount = chipsBefore
    while (Date.now() < waitDeadline) {
      await this.waitIfPausedOrThrowIfStopped()
      chipCount = await page.locator(STUDIO_SELECTORS.videoMediaChips.join(', ')).count()
      if (chipCount > chipsBefore) break
      await new Promise((r) => setTimeout(r, 500))
    }

    // Open Video Settings on the newly added video chip to set start/end time & FPS = 24
    const startStr = this.formatClockForStudioInput(startSec)
    const endStr = this.formatClockForStudioInput(endSec)

    try {
      const chips = page.locator(STUDIO_SELECTORS.videoMediaChips.join(', '))
      const targetChip = chips.nth(Math.max(0, chipCount - 1))
      if ((await targetChip.count()) > 0) {
        await targetChip.hover().catch(() => {})
        await new Promise((r) => setTimeout(r, 250))

        // Click either the settings icon inside the chip or the chip itself
        const settingsBtnInside = targetChip.locator('button').first()
        if ((await settingsBtnInside.count()) > 0) {
          await settingsBtnInside.click()
        } else {
          await targetChip.click()
        }
        await new Promise((r) => setTimeout(r, 500))

        const startInput = await findFirstVisibleLocator(page, STUDIO_SELECTORS.videoStartTimeInput, 2500)
        const endInput = await findFirstVisibleLocator(page, STUDIO_SELECTORS.videoEndTimeInput, 2500)
        const fpsInput = await findFirstVisibleLocator(page, STUDIO_SELECTORS.videoFpsInput, 2500)

        if (startInput) {
          await startInput.click({ clickCount: 3 })
          await startInput.fill(startStr)
        }
        if (endInput) {
          await endInput.click({ clickCount: 3 })
          await endInput.fill(endStr)
        }
        if (fpsInput) {
          await fpsInput.click({ clickCount: 3 })
          await fpsInput.fill(String(fps))
        }

        const saveBtn = await findFirstVisibleLocator(page, STUDIO_SELECTORS.videoSettingsSaveButton, 1800)
        if (saveBtn) {
          await saveBtn.click()
        } else {
          await page.keyboard.press('Escape')
        }
        await new Promise((r) => setTimeout(r, 600))
      }
    } catch (err) {
      this.logStep(
        `${label} clip range warning`,
        `Could not set clip dialog (${ err instanceof Error ? err.message : String(err) })`,
        'warn',
      )
    }

    this.logStep(
      `${label} attached`,
      `${startStr}–${endStr} @ ${fps} FPS`,
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
   * c. Attach Video 1 (short part) & Video 2 (movie_360p from Drive), set start/end times + FPS=24
   * d. Read token counter -> if > 900K, signal caller to shrink movie block and retry
   * e. Paste prompt and run -> wait up to 15m -> detect quota/error banners with backoff -> policy retry
   * f. Copy final answer text only (no thoughts) -> calibrate offset mode -> parseChunkMatches
   */
  public async runWindowJob(params: {
    username: string
    scanId: string
    jobLabel: string
    modelName: string
    maxOutputTokens: number
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
    | { status: 'shrink_needed'; tokenCount: number }
    | {
        status: 'success'
        rawText: string
        tokenCount: number
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

    this.setJobContext(scanId, jobLabel)
    const page = await this.ensurePage(username)

    const MAX_ATTEMPTS = 3
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.waitIfPausedOrThrowIfStopped()

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
        await this.configureRunSettings(page, { modelName, maxOutputTokens })

        // (c) Attach Video 1 = short part & Video 2 = movie_360p from Drive, set start/end & 24 FPS
        await this.attachVideoAndConfigureRange(page, {
          label: 'short',
          youtubeUrl: shortYoutubeUrl,
          driveFileName: shortDriveFileName,
          localFilePath: shortLocalPath,
          startSec: shortStartSec,
          endSec: shortEndSec,
          fps: 24,
        })

        await this.attachVideoAndConfigureRange(page, {
          label: 'movie',
          driveFileName: movieDriveFileName,
          localFilePath: movieLocalPath,
          startSec: movieStartSec,
          endSec: movieEndSec,
          fps: 24,
        })

        // Wait briefly for AI Studio to finish counting media tokens
        await new Promise((r) => setTimeout(r, 3000))

        // (d) Read Studio's token counter. If > ~900K: shrink the movie block and retry.
        const tokens = await this.readStudioTokenCount(page)
        if (tokens !== null && tokens > 900_000) {
          const msg = `Studio token counter is ${(tokens / 1000).toFixed(0)}K (> 900K limit) for ${jobLabel} — shrinking movie block and retrying`
          this.logStep('shrinking block', msg, 'warn')
          onLog?.('warn', msg)
          return { status: 'shrink_needed', tokenCount: tokens }
        }

        // (e) Paste the chunk prompt and run
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
        await new Promise((r) => setTimeout(r, 400))

        const runBtn = await findFirstVisibleLocator(page, STUDIO_SELECTORS.runButton, 4000)
        if (runBtn) {
          await runBtn.click()
        } else {
          await promptInput.press('Control+Enter')
        }

        // Wait until generation finishes (Stop button gone / Run enabled) with a 15-min timeout
        const runStarted = Date.now()
        const TIMEOUT_MS = 15 * 60_000
        let rawAnswer = ''

        while (Date.now() - runStarted < TIMEOUT_MS) {
          await this.waitIfPausedOrThrowIfStopped()
          const elapsed = Math.floor((Date.now() - runStarted) / 1000)
          const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
          const ss = String(elapsed % 60).padStart(2, '0')
          this.logStep(`running ${mm}:${ss}`, jobLabel)

          // Check for error / quota / safety banners
          const errBannerText = await page.evaluate((sels) => {
            for (const s of sels) {
              const el = document.querySelector(s)
              if (el && (el as HTMLElement).innerText) {
                const t = (el as HTMLElement).innerText.trim()
                if (/exhausted|quota|try again|rate limit|error|blocked|prohibited_content|safety/i.test(t)) {
                  return t
                }
              }
            }
            return null
          }, [...STUDIO_SELECTORS.errorBanners])

          if (errBannerText) {
            if (/prohibited_content|blocked|safety/i.test(errBannerText) && !sanitized) {
              onLog?.(
                'warn',
                `Studio flagged content policy on ${jobLabel} — retrying once with sanitized neutral prompt`,
              )
              return this.runWindowJob({ ...params, sanitized: true })
            }
            throw new Error(`AI Studio banner error: ${errBannerText.slice(0, 180)}`)
          }

          // Check if generation finished (after at least 4s of running)
          if (elapsed >= 4) {
            const stopLoc = await findFirstVisibleLocator(page, STUDIO_SELECTORS.stopButton, 300)
            if (!stopLoc) {
              const candidateText = await this.extractFinalAnswerWithoutThoughts(page)
              if (
                candidateText &&
                (candidateText.includes('-->') ||
                  /NOT\s*FOUND/i.test(candidateText) ||
                  candidateText.length > 40)
              ) {
                rawAnswer = candidateText
                break
              }
            }
          }

          await new Promise((r) => setTimeout(r, 1500))
        }

        if (!rawAnswer) {
          rawAnswer = await this.extractFinalAnswerWithoutThoughts(page)
        }
        if (!rawAnswer) {
          throw new Error(`Timed out or empty answer from AI Studio for ${jobLabel}`)
        }

        this.logStep('answer copied', `${rawAnswer.length} chars extracted (thoughts excluded)`, 'success')

        // (f) & (g) Calibrate offset mode (relative 0:00 vs absolute startSec) and parse via parseChunkMatches!
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

        return {
          status: 'success',
          rawText: rawAnswer,
          tokenCount: tokens || Math.round(((shortEndSec - shortStartSec) + (movieEndSec - movieStartSec)) * 260),
          matches: calibrated.matches,
          calibratedOffsetMode: calibrated.offsetMode,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const isPolicy = /prohibited_content|blocked|safety/i.test(msg)
        if (isPolicy && sanitized) {
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
