import { NextRequest, NextResponse } from 'next/server'
import { studioController } from '@/lib/studio-automation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const once = req.nextUrl.searchParams.get('once') === '1'
  if (once) {
    const snap = await studioController.getSnapshot(true)
    return NextResponse.json(snap)
  }

  const encoder = new TextEncoder()
  let closed = false

  const stream = new ReadableStream({
    async start(controller) {
      const send = async () => {
        if (closed) return
        try {
          const snap = await studioController.getSnapshot(true)
          const payload = `data: ${JSON.stringify(snap)}\n\n`
          controller.enqueue(encoder.encode(payload))
        } catch {
          /* ignore */
        }
      }

      await send()
      const timer = setInterval(() => {
        if (closed) {
          clearInterval(timer)
          return
        }
        void send()
      }, 1000)

      req.signal.addEventListener('abort', () => {
        closed = true
        clearInterval(timer)
        try {
          controller.close()
        } catch {
          /* ignore */
        }
      })
    },
    cancel() {
      closed = true
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
