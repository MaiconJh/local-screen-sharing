import { NextResponse } from "next/server"
import { sessionStore } from "@/lib/session-store"

export async function POST(request: Request) {
  const body = await request.json()
  const { action, hostId, token, clientId } = body

  switch (action) {
    case "create": {
      const session = sessionStore.createSession(hostId)
      return NextResponse.json({
        success: true,
        session: {
          id: session.id,
          token: session.token,
          active: session.active,
          clientCount: session.clients.length,
        },
      })
    }

    case "destroy": {
      sessionStore.destroySession()
      return NextResponse.json({ success: true })
    }

    case "status": {
      const session = sessionStore.getSession()
      if (!session) {
        return NextResponse.json({
          active: false,
          clientCount: 0,
          controlLocked: false,
        })
      }
      return NextResponse.json({
        active: session.active,
        clientCount: session.clients.length,
        clients: session.clients,
        controlLocked: session.controlLocked,
        token: session.token,
        sessionId: session.id,
      })
    }

    case "join": {
      const session = sessionStore.validateToken(token)
      if (!session) {
        return NextResponse.json(
          { success: false, error: "Session ended" },
          { status: 403 }
        )
      }
      const result = sessionStore.addClient(clientId)
      if (!result.success) {
        return NextResponse.json(
          { success: false, error: result.error },
          { status: 403 }
        )
      }
      return NextResponse.json({
        success: true,
        role: result.role,
        sessionId: session.id,
      })
    }

    case "leave": {
      const leaveResult = sessionStore.removeClient(clientId)
      return NextResponse.json({
        success: true,
        promoted: leaveResult.promoted,
        promotedId: leaveResult.promotedId,
      })
    }

    case "toggle-lock": {
      const locked = sessionStore.toggleControlLock()
      return NextResponse.json({ success: true, controlLocked: locked })
    }

    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  }
}

export async function GET() {
  const session = sessionStore.getSession()
  if (!session) {
    return NextResponse.json({ active: false })
  }
  return NextResponse.json({
    active: session.active,
    clientCount: session.clients.length,
    clients: session.clients,
    controlLocked: session.controlLocked,
  })
}
