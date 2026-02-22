import { NextResponse } from "next/server"
import { sessionStore } from "@/lib/session-store"
import type { SignalMessage } from "@/lib/types"

export async function POST(request: Request) {
  const message: SignalMessage = await request.json()
  sessionStore.sendSignal(message)
  return NextResponse.json({ success: true })
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const listenerId = url.searchParams.get("listenerId")

  if (!listenerId) {
    return NextResponse.json({ error: "Missing listenerId" }, { status: 400 })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      const sendEvent = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {
          // stream closed
        }
      }

      sendEvent({ type: "connected", listenerId })

      const removeListener = sessionStore.addSignalListener(listenerId, (signal) => {
        sendEvent(signal)
      })

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`))
        } catch {
          clearInterval(heartbeat)
        }
      }, 15000)

      request.signal.addEventListener("abort", () => {
        removeListener()
        clearInterval(heartbeat)
        try {
          controller.close()
        } catch {
          // already closed
        }
      })
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
}
