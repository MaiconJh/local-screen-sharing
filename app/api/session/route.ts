import { NextResponse } from "next/server"
import { sessionStore } from "@/lib/session-store"

export async function POST(request: Request) {
  const body = await request.json()
  const { action, hostId, hostLabel, token, accessCode, clientId } = body

  switch (action) {
    case "create": {
      const session = sessionStore.createSession(hostId, hostLabel)
      return NextResponse.json({
        success: true,
        session: {
          id: session.id,
          token: session.token,
          active: session.active,
          clientCount: session.clients.length,
          accessCode: session.accessCode,
          hostLabel: session.hostLabel,
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
        hostLabel: session.hostLabel,
      })
    }

    case "preview": {
      const session = sessionStore.validateToken(token)
      if (!session) {
        return NextResponse.json(
          { success: false, error: "Session ended" },
          { status: 403 }
        )
      }
      return NextResponse.json({
        success: true,
        hostLabel: session.hostLabel,
        active: session.active,
        clientCount: session.clients.length,
      })
    }

    case "join": {
      const sessionByToken = sessionStore.validateToken(token)
      if (!sessionByToken) {
        return NextResponse.json(
          { success: false, error: "Session ended" },
          { status: 403 }
        )
      }
      if (!accessCode || sessionByToken.accessCode !== String(accessCode)) {
        return NextResponse.json(
          { success: false, error: "Invalid access code" },
          { status: 403 }
        )
      }
      const session = sessionByToken
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
        hostId: session.hostId,
        hostLabel: session.hostLabel,
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
