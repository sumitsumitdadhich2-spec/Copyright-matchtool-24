import crypto from 'crypto'
import fs from 'fs'
import { loadUserDriveTokens, saveUserDriveTokens, type DriveTokenBundle } from './studio-settings'

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const DRIVE_FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files'
const DRIVE_UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3/files'
const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ')

function getOAuthCredentials(originOverride?: string) {
  const clientId = (process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim()
  const clientSecret = (process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim()
  const configuredRedirect = (process.env.GOOGLE_OAUTH_REDIRECT_URI || '').trim()
  const redirectUri =
    configuredRedirect ||
    (originOverride ? `${originOverride.replace(/\/$/, '')}/api/drive/callback` : 'http://localhost:3000/api/drive/callback')

  if (!clientId || !clientSecret) {
    throw new Error(
      'Google OAuth credentials missing. Please set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in your environment (.env).',
    )
  }
  return { clientId, clientSecret, redirectUri }
}

export function createSignedOAuthState(username: string, redirectUri: string): string {
  const secret = process.env.SESSION_SECRET || 'cmt-default-session-secret-change-me'
  const payload = JSON.stringify({
    u: username,
    r: redirectUri,
    t: Date.now(),
  })
  const b64 = Buffer.from(payload, 'utf8').toString('base64url')
  const sig = crypto.createHmac('sha256', secret).update(b64).digest('base64url')
  return `${b64}.${sig}`
}

export function verifySignedOAuthState(state: string): { username: string; redirectUri: string } | null {
  const parts = (state || '').split('.')
  if (parts.length !== 2) return null
  const [b64, sig] = parts
  const secret = process.env.SESSION_SECRET || 'cmt-default-session-secret-change-me'
  const expected = crypto.createHmac('sha256', secret).update(b64).digest('base64url')
  if (sig !== expected) return null
  try {
    const parsed = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as {
      u?: string
      r?: string
      t?: number
    }
    if (!parsed.u || !parsed.r) return null
    if (parsed.t && Date.now() - parsed.t > 30 * 60_000) return null
    return { username: parsed.u, redirectUri: parsed.r }
  } catch {
    return null
  }
}

export function buildDriveOAuthConsentUrl(username: string, origin?: string): string {
  const { clientId, redirectUri } = getOAuthCredentials(origin)
  const state = createSignedOAuthState(username, redirectUri)
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: DRIVE_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  })
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`
}

export async function exchangeDriveCodeAndSave(
  username: string,
  code: string,
  redirectUriOverride?: string,
): Promise<{ email?: string }> {
  const { clientId, clientSecret, redirectUri } = getOAuthCredentials()
  const finalRedirect = redirectUriOverride || redirectUri

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: finalRedirect,
    grant_type: 'authorization_code',
  })

  const tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!tokenRes.ok) {
    const errText = await tokenRes.text()
    throw new Error(`Google OAuth token exchange failed (${tokenRes.status}): ${errText.slice(0, 200)}`)
  }

  const tokenData = (await tokenRes.json()) as {
    access_token: string
    refresh_token?: string
    expires_in?: number
  }

  const existing = await loadUserDriveTokens(username)
  const refreshToken = tokenData.refresh_token || existing?.refresh_token
  if (!refreshToken) {
    throw new Error('Google did not return a refresh_token. Please disconnect and reconnect with prompt=consent.')
  }

  let email: string | undefined = existing?.email
  if (tokenData.access_token) {
    try {
      const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      })
      if (infoRes.ok) {
        const info = (await infoRes.json()) as { email?: string }
        if (info.email) email = info.email
      }
    } catch {
      /* ignore email lookup error */
    }
  }

  const bundle: DriveTokenBundle = {
    refresh_token: refreshToken,
    access_token: tokenData.access_token,
    expiry_date: tokenData.expires_in ? Date.now() + (tokenData.expires_in - 60) * 1000 : undefined,
    email,
  }
  await saveUserDriveTokens(username, bundle)
  return { email }
}

export async function getValidDriveAccessToken(username: string): Promise<string> {
  const bundle = await loadUserDriveTokens(username)
  if (!bundle || !bundle.refresh_token) {
    throw new Error('Google Drive is not connected. Open Settings -> Connect Drive first.')
  }

  if (bundle.access_token && bundle.expiry_date && bundle.expiry_date > Date.now() + 30_000) {
    return bundle.access_token
  }

  const { clientId, clientSecret } = getOAuthCredentials()
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: bundle.refresh_token,
    grant_type: 'refresh_token',
  })

  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Failed to refresh Google Drive access token (${res.status}): ${errText.slice(0, 200)}`)
  }

  const data = (await res.json()) as { access_token: string; expires_in?: number }
  const updated: DriveTokenBundle = {
    ...bundle,
    access_token: data.access_token,
    expiry_date: data.expires_in ? Date.now() + (data.expires_in - 60) * 1000 : Date.now() + 3300_000,
  }
  await saveUserDriveTokens(username, updated)
  return data.access_token
}

/**
 * Find or create the "CMT" folder in the user's Google Drive.
 */
export async function ensureCmtDriveFolder(accessToken: string): Promise<string> {
  const q = encodeURIComponent(
    "name = 'CMT' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
  )
  const searchRes = await fetch(`${DRIVE_FILES_ENDPOINT}?q=${q}&fields=files(id,name)&pageSize=5`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (searchRes.ok) {
    const data = (await searchRes.json()) as { files?: Array<{ id: string; name: string }> }
    if (data.files && data.files.length > 0) {
      return data.files[0].id
    }
  }

  // Create folder "CMT"
  const createRes = await fetch(DRIVE_FILES_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'CMT',
      mimeType: 'application/vnd.google-apps.folder',
    }),
  })
  if (!createRes.ok) {
    const txt = await createRes.text()
    throw new Error(`Failed to create "CMT" folder in Google Drive (${createRes.status}): ${txt.slice(0, 200)}`)
  }
  const created = (await createRes.json()) as { id: string }
  return created.id
}

/**
 * Upload a video file to the "CMT" folder in Google Drive using Google Drive's Resumable Upload protocol.
 * Streams in 8 MB chunks so large files (~390 MB) upload reliably with progress updates.
 */
export async function uploadFileToDriveResumable(params: {
  username: string
  localFilePath: string
  driveFileName: string
  mimeType?: string
  onProgress?: (pct: number) => void
}): Promise<{ fileId: string; fileName: string }> {
  const { username, localFilePath, driveFileName, mimeType = 'video/mp4', onProgress } = params
  const stat = fs.statSync(localFilePath)
  const totalBytes = stat.size

  const accessToken = await getValidDriveAccessToken(username)
  const folderId = await ensureCmtDriveFolder(accessToken)

  // Check if a file with this exact name already exists inside "CMT" folder (for idempotent resume)
  const safeName = driveFileName.replace(/'/g, "\\'")
  const existingQ = encodeURIComponent(
    `name = '${safeName}' and '${folderId}' in parents and trashed = false`,
  )
  const checkRes = await fetch(`${DRIVE_FILES_ENDPOINT}?q=${existingQ}&fields=files(id,name,size)&pageSize=1`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (checkRes.ok) {
    const checkData = (await checkRes.json()) as {
      files?: Array<{ id: string; name: string; size?: string }>
    }
    const existingFile = checkData.files?.[0]
    if (existingFile && Number(existingFile.size) === totalBytes) {
      onProgress?.(100)
      return { fileId: existingFile.id, fileName: existingFile.name }
    }
  }

  // 1. Initiate Resumable Upload session
  const initRes = await fetch(`${DRIVE_UPLOAD_ENDPOINT}?uploadType=resumable`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(totalBytes),
    },
    body: JSON.stringify({
      name: driveFileName,
      parents: [folderId],
    }),
  })

  if (!initRes.ok) {
    const errText = await initRes.text()
    throw new Error(`Drive resumable upload init failed (${initRes.status}): ${errText.slice(0, 200)}`)
  }

  const sessionUri = initRes.headers.get('location')
  if (!sessionUri) {
    throw new Error('Drive resumable upload did not return a Location header')
  }

  // 2. Upload in 8 MB chunks (must be a multiple of 256 KB per Google Drive spec)
  const CHUNK_SIZE = 8 * 1024 * 1024 // 8 MB
  const fd = fs.openSync(localFilePath, 'r')
  try {
    let offset = 0
    while (offset < totalBytes) {
      const length = Math.min(CHUNK_SIZE, totalBytes - offset)
      const buffer = Buffer.allocUnsafe(length)
      const bytesRead = fs.readSync(fd, buffer, 0, length, offset)
      const slice = bytesRead < length ? buffer.subarray(0, bytesRead) : buffer
      const endByte = offset + slice.length - 1

      let uploaded: { id: string; name?: string } | null = null
      let lastErr: Error | null = null

      for (let retry = 0; retry < 3; retry++) {
        try {
          const putRes = await fetch(sessionUri, {
            method: 'PUT',
            headers: {
              'Content-Length': String(slice.length),
              'Content-Range': `bytes ${offset}-${endByte}/${totalBytes}`,
            },
            body: slice,
          })

          if (putRes.status === 308) {
            // Resume Incomplete — chunk accepted
            lastErr = null
            break
          } else if (putRes.status === 200 || putRes.status === 201) {
            uploaded = (await putRes.json()) as { id: string; name?: string }
            lastErr = null
            break
          } else {
            const errTxt = await putRes.text()
            lastErr = new Error(`Drive chunk PUT failed (${putRes.status}): ${errTxt.slice(0, 160)}`)
          }
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err))
        }
        await new Promise((r) => setTimeout(r, 1500 * (retry + 1)))
      }

      if (lastErr) throw lastErr

      offset += slice.length
      const pct = Math.min(99, Math.round((offset / totalBytes) * 100))
      onProgress?.(pct)

      if (uploaded) {
        onProgress?.(100)
        return { fileId: uploaded.id, fileName: uploaded.name || driveFileName }
      }
    }
  } finally {
    fs.closeSync(fd)
  }

  throw new Error('Drive resumable upload finished bytes without returning file ID')
}
