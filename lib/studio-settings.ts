import crypto from 'crypto'
import { readJSONRecord, writeJSONRecord } from './json-record'
import type { ChunkScanEngine } from './types'

export interface StudioUserConfig {
  chunkScanEngine: ChunkScanEngine
  studioModelName: string
  studioMaxOutputTokens: number
  studioWindowMinutes: number
  studioShortPartMinutes: number
  studioWindowOverlapSec: number
  /** Calibrated offset mode when start/end clip timestamps are set in AI Studio:
   *  - 'auto': not yet calibrated; first job with startSec >= 60 auto-detects and saves 'relative' or 'absolute'
   *  - 'relative': Studio returns timestamps relative to the clip start (00:00 = clip startSec)
   *  - 'absolute': Studio returns timestamps relative to the original video (00:00 = video 00:00)
   */
  studioOffsetMode: 'auto' | 'relative' | 'absolute'
  /** Encrypted JSON string (Cookie-Editor array or Playwright storageState) — NEVER sent to client */
  encryptedCookies?: string
  /** Last verified login state */
  lastLoginEmail?: string | null
  lastLoginStatus?: 'logged_in' | 'logged_out' | 'untested'
  lastLoginTestedAt?: number | null
  /** Encrypted Google Drive OAuth token bundle — NEVER sent to client */
  encryptedDriveTokens?: string
  driveConnectedEmail?: string | null
  driveConnectedAt?: number | null
  updatedAt: number
}

export interface PublicStudioSettings {
  chunkScanEngine: ChunkScanEngine
  studioModelName: string
  studioMaxOutputTokens: number
  studioWindowMinutes: number
  studioShortPartMinutes: number
  studioWindowOverlapSec: number
  studioOffsetMode: 'auto' | 'relative' | 'absolute'
  hasCookies: boolean
  cookieCount: number
  lastLoginEmail: string | null
  lastLoginStatus: 'logged_in' | 'logged_out' | 'untested'
  lastLoginTestedAt: number | null
  driveConnected: boolean
  driveConnectedEmail: string | null
  driveConnectedAt: number | null
  oauthClientConfigured: boolean
}

export interface DriveTokenBundle {
  refresh_token: string
  access_token?: string
  expiry_date?: number
  email?: string
}

export interface PlaywrightCookie {
  name: string
  value: string
  domain: string
  path: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

const DEFAULT_STUDIO_CONFIG: StudioUserConfig = {
  chunkScanEngine: 'api',
  studioModelName: 'Gemini 2.5 Pro',
  studioMaxOutputTokens: 65536,
  studioWindowMinutes: 5,
  studioShortPartMinutes: 3,
  studioWindowOverlapSec: 0,
  studioOffsetMode: 'auto',
  lastLoginStatus: 'untested',
  updatedAt: 0,
}

function getEncryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET || 'cmt-default-session-secret-change-me'
  return crypto.scryptSync(secret, 'cmt-studio-aes-salt-v1', 32)
}

export function encryptSecret(plainText: string): string {
  const key = getEncryptionKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`
}

export function decryptSecret(cipherText: string): string {
  const parts = (cipherText || '').split(':')
  if (parts.length !== 3) throw new Error('Invalid encrypted payload format')
  const [ivB64, tagB64, dataB64] = parts
  const key = getEncryptionKey()
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const data = Buffer.from(dataB64, 'base64')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const dec = Buffer.concat([decipher.update(data), decipher.final()])
  return dec.toString('utf8')
}

function recordKey(username: string): string {
  const safe = (username || 'admin').toLowerCase().replace(/[^a-z0-9._-]/g, '_')
  return `auth/studio/${safe}.json`
}

export async function loadStudioUserConfig(username: string): Promise<StudioUserConfig> {
  const raw = await readJSONRecord<Partial<StudioUserConfig>>(recordKey(username))
  return {
    ...DEFAULT_STUDIO_CONFIG,
    ...(raw || {}),
    chunkScanEngine: raw?.chunkScanEngine === 'studio' ? 'studio' : 'api',
    studioModelName: (raw?.studioModelName || DEFAULT_STUDIO_CONFIG.studioModelName).trim() || DEFAULT_STUDIO_CONFIG.studioModelName,
    studioMaxOutputTokens: Math.max(1024, Math.min(65536, Number(raw?.studioMaxOutputTokens) || DEFAULT_STUDIO_CONFIG.studioMaxOutputTokens)),
    studioWindowMinutes: Math.max(1, Math.min(15, Number(raw?.studioWindowMinutes) || DEFAULT_STUDIO_CONFIG.studioWindowMinutes)),
    studioShortPartMinutes: Math.max(1, Math.min(10, Number(raw?.studioShortPartMinutes) || DEFAULT_STUDIO_CONFIG.studioShortPartMinutes)),
    studioWindowOverlapSec: Math.max(0, Math.min(60, Number(raw?.studioWindowOverlapSec ?? DEFAULT_STUDIO_CONFIG.studioWindowOverlapSec))),
    studioOffsetMode:
      raw?.studioOffsetMode === 'relative' || raw?.studioOffsetMode === 'absolute'
        ? raw.studioOffsetMode
        : 'auto',
  }
}

export async function saveStudioUserConfig(
  username: string,
  patch: Partial<StudioUserConfig>,
): Promise<StudioUserConfig> {
  const current = await loadStudioUserConfig(username)
  const next: StudioUserConfig = {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  }
  await writeJSONRecord(recordKey(username), next)
  return next
}

/**
 * Parse either Cookie-Editor JSON array or Playwright storageState JSON
 * into normalized Playwright cookies.
 */
export function parseCookieInputToPlaywright(rawJson: string): PlaywrightCookie[] {
  const trimmed = (rawJson || '').trim()
  if (!trimmed) throw new Error('Cookies JSON is empty')
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (err) {
    throw new Error(`Invalid JSON in Google cookies field: ${err instanceof Error ? err.message : String(err)}`)
  }

  let rawList: unknown[] = []
  if (Array.isArray(parsed)) {
    rawList = parsed
  } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { cookies?: unknown[] }).cookies)) {
    rawList = (parsed as { cookies: unknown[] }).cookies
  } else {
    throw new Error('Cookies JSON must be a Cookie-Editor JSON array [...] or Playwright storageState {"cookies": [...]}')
  }

  const out: PlaywrightCookie[] = []
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue
    const c = item as Record<string, unknown>
    const name = typeof c.name === 'string' ? c.name.trim() : ''
    const value = typeof c.value === 'string' ? c.value : ''
    const domain = typeof c.domain === 'string' ? c.domain.trim() : ''
    if (!name || !domain) continue
    const cookiePath = typeof c.path === 'string' && c.path ? c.path : '/'
    const rawExp = Number(c.expirationDate ?? c.expires ?? -1)
    const expires = Number.isFinite(rawExp) && rawExp > 0 ? rawExp : undefined
    const httpOnly = Boolean(c.httpOnly)
    const secure = c.secure !== undefined ? Boolean(c.secure) : true

    let sameSite: 'Strict' | 'Lax' | 'None' | undefined
    if (typeof c.sameSite === 'string') {
      const s = c.sameSite.toLowerCase()
      if (s === 'strict') sameSite = 'Strict'
      else if (s === 'lax') sameSite = 'Lax'
      else if (s === 'no_restriction' || s === 'none') sameSite = 'None'
    }
    if (sameSite === 'None' && !secure) {
      sameSite = 'Lax'
    }

    out.push({
      name,
      value,
      domain,
      path: cookiePath,
      ...(expires ? { expires } : {}),
      httpOnly,
      secure,
      ...(sameSite ? { sameSite } : {}),
    })
  }

  if (out.length === 0) {
    throw new Error('No valid Google cookies found in the provided JSON.')
  }
  return out
}

export async function saveUserGoogleCookies(username: string, rawCookieJson: string): Promise<{ count: number }> {
  const cookies = parseCookieInputToPlaywright(rawCookieJson)
  const encryptedCookies = encryptSecret(JSON.stringify(cookies))
  await saveStudioUserConfig(username, {
    encryptedCookies,
    lastLoginStatus: 'untested',
  })
  return { count: cookies.length }
}

export async function loadDecryptedPlaywrightCookies(username: string): Promise<PlaywrightCookie[]> {
  const cfg = await loadStudioUserConfig(username)
  if (!cfg.encryptedCookies) return []
  try {
    const plain = decryptSecret(cfg.encryptedCookies)
    return parseCookieInputToPlaywright(plain)
  } catch {
    return []
  }
}

export async function saveUserDriveTokens(username: string, bundle: DriveTokenBundle): Promise<void> {
  const encryptedDriveTokens = encryptSecret(JSON.stringify(bundle))
  await saveStudioUserConfig(username, {
    encryptedDriveTokens,
    driveConnectedEmail: bundle.email || null,
    driveConnectedAt: Date.now(),
  })
}

export async function loadUserDriveTokens(username: string): Promise<DriveTokenBundle | null> {
  const cfg = await loadStudioUserConfig(username)
  if (!cfg.encryptedDriveTokens) return null
  try {
    const plain = decryptSecret(cfg.encryptedDriveTokens)
    const parsed = JSON.parse(plain) as DriveTokenBundle
    if (!parsed || typeof parsed.refresh_token !== 'string' || !parsed.refresh_token) return null
    return parsed
  } catch {
    return null
  }
}

export async function getPublicStudioSettings(username: string): Promise<PublicStudioSettings> {
  const cfg = await loadStudioUserConfig(username)
  let cookieCount = 0
  if (cfg.encryptedCookies) {
    try {
      const cookies = JSON.parse(decryptSecret(cfg.encryptedCookies))
      if (Array.isArray(cookies)) cookieCount = cookies.length
    } catch {
      cookieCount = 0
    }
  }
  let driveConnected = false
  if (cfg.encryptedDriveTokens) {
    try {
      const tokens = JSON.parse(decryptSecret(cfg.encryptedDriveTokens)) as DriveTokenBundle
      driveConnected = Boolean(tokens?.refresh_token)
    } catch {
      driveConnected = false
    }
  }

  return {
    chunkScanEngine: cfg.chunkScanEngine,
    studioModelName: cfg.studioModelName,
    studioMaxOutputTokens: cfg.studioMaxOutputTokens,
    studioWindowMinutes: cfg.studioWindowMinutes,
    studioShortPartMinutes: cfg.studioShortPartMinutes,
    studioWindowOverlapSec: cfg.studioWindowOverlapSec,
    studioOffsetMode: cfg.studioOffsetMode,
    hasCookies: cookieCount > 0,
    cookieCount,
    lastLoginEmail: cfg.lastLoginEmail ?? null,
    lastLoginStatus: cfg.lastLoginStatus ?? 'untested',
    lastLoginTestedAt: cfg.lastLoginTestedAt ?? null,
    driveConnected,
    driveConnectedEmail: cfg.driveConnectedEmail ?? null,
    driveConnectedAt: cfg.driveConnectedAt ?? null,
    oauthClientConfigured: Boolean(
      process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    ),
  }
}
