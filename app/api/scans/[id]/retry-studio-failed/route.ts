import { NextRequest, NextResponse } from 'next/server'
import { scheduler } from '@/lib/scheduler'
import { getSession } from '@/lib/users'
import { getAllUserApiKeys, getUserTwelveLabsKey } from '@/lib/user-keys'
import { getScan } from '@/lib/store'

export const runtime = 'nodejs'

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 })
  }

  const scan = getScan(id)
  if (!scan) {
    return NextResponse.json({ ok: false, error: 'Scan not found' }, { status: 404 })
  }
  if (session.role !== 'admin' && scan.ownerUsername && scan.ownerUsername !== session.username) {
    return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
  }

  const targetOwner = scan.ownerUsername || session.username
  const userApiKeys = await getAllUserApiKeys(targetOwner)
  const tlApiKey = await getUserTwelveLabsKey(targetOwner)

  const result = await scheduler.retryFailedStudioWindows(id, userApiKeys, tlApiKey)
  if (!result.ok) {
    return NextResponse.json(result, { status: 400 })
  }
  return NextResponse.json({ ...result, scan: getScan(id) })
}
