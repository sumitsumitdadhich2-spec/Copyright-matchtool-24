import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/users'
import { buildDriveOAuthConsentUrl } from '@/lib/google-drive'
import { saveStudioUserConfig } from '@/lib/studio-settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const user = await getSession()
  const username = user?.username || 'admin'
  try {
    const origin = req.headers.get('origin') || req.nextUrl.origin
    const url = buildDriveOAuthConsentUrl(username, origin)
    return NextResponse.json({ ok: true, url })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    )
  }
}

export async function DELETE() {
  const user = await getSession()
  const username = user?.username || 'admin'
  await saveStudioUserConfig(username, {
    encryptedDriveTokens: undefined,
    driveConnectedEmail: null,
    driveConnectedAt: null,
  })
  return NextResponse.json({ ok: true })
}
