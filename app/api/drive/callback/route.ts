import { NextRequest, NextResponse } from 'next/server'
import { exchangeDriveCodeAndSave, verifySignedOAuthState } from '@/lib/google-drive'
import { getSession } from '@/lib/users'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  const state = req.nextUrl.searchParams.get('state') || ''
  const errorParam = req.nextUrl.searchParams.get('error')

  if (errorParam) {
    return new NextResponse(
      `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#09090b;color:#f4f4f5;padding:32px;text-align:center;">
        <h2 style="color:#f87171;">Google Drive Connection Cancelled</h2>
        <p>${errorParam}</p>
        <p><a href="/" style="color:#60a5fa;">Return to Shiva MatchTool</a></p>
      </body></html>`,
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    )
  }

  if (!code) {
    return NextResponse.json({ error: 'Missing OAuth code' }, { status: 400 })
  }

  const verified = verifySignedOAuthState(state)
  const sessionUser = await getSession()
  const username = verified?.username || sessionUser?.username || 'admin'

  try {
    const { email } = await exchangeDriveCodeAndSave(username, code, verified?.redirectUri)
    return new NextResponse(
      `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#09090b;color:#f4f4f5;padding:32px;text-align:center;">
        <h2 style="color:#34d399;">Google Drive Connected Successfully</h2>
        <p>Account: <strong>${email || 'Connected'}</strong> (scope: <code>drive.file</code>)</p>
        <p>Redirecting back to Shiva MatchTool...</p>
        <script>
          try {
            if (window.opener) {
              window.opener.postMessage({ type: 'cmt-drive-connected', email: ${JSON.stringify(email || '')} }, '*');
              setTimeout(() => window.close(), 800);
            } else {
              setTimeout(() => { window.location.href = '/'; }, 1000);
            }
          } catch (e) {
            window.location.href = '/';
          }
        </script>
      </body></html>`,
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return new NextResponse(
      `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#09090b;color:#f4f4f5;padding:32px;text-align:center;">
        <h2 style="color:#f87171;">Google Drive Connection Failed</h2>
        <p>${msg}</p>
        <p><a href="/" style="color:#60a5fa;">Return to Shiva MatchTool</a></p>
      </body></html>`,
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    )
  }
}
