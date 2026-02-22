import { randomBytes } from "crypto"
import type { Session, ConnectedClient, ClientRole, SignalMessage } from "./types"

type SignalListener = (message: SignalMessage) => void

class SessionStore {
  private session: Session | null = null
  private signalListeners: Map<string, SignalListener[]> = new Map()

  createSession(hostId: string, hostLabel?: string): Session {
    if (this.session?.active) {
      this.destroySession()
    }

    const token = randomBytes(32).toString("hex")
    const accessCode = String(Math.floor(100000 + Math.random() * 900000))
    this.session = {
      id: randomBytes(16).toString("hex"),
      token,
      accessCode,
      hostId,
      hostLabel: hostLabel?.trim() || `Host-${hostId.slice(0, 6)}`,
      active: true,
      createdAt: Date.now(),
      clients: [],
      maxClients: 2,
      controlLocked: false,
    }
    return this.session
  }

  destroySession(): void {
    if (this.session) {
      this.session.active = false
      this.session.clients = []
      this.signalListeners.clear()
    }
    this.session = null
  }

  getSession(): Session | null {
    return this.session
  }

  validateToken(token: string, accessCode?: string): Session | null {
    if (!this.session?.active || this.session.token !== token) {
      return null
    }
    if (accessCode && this.session.accessCode !== accessCode) {
      return null
    }
    return this.session
  }

  addClient(clientId: string): { success: boolean; role: ClientRole; error?: string } {
    if (!this.session?.active) {
      return { success: false, role: "viewer", error: "Session ended" }
    }

    const existing = this.session.clients.find((c) => c.id === clientId)
    if (existing) {
      return { success: true, role: existing.role }
    }

    if (this.session.clients.length >= this.session.maxClients) {
      return { success: false, role: "viewer", error: "Host full" }
    }

    const role: ClientRole = this.session.clients.length === 0 ? "controller" : "viewer"
    const client: ConnectedClient = {
      id: clientId,
      role,
      connectedAt: Date.now(),
    }

    this.session.clients.push(client)
    return { success: true, role }
  }

  removeClient(clientId: string): { promoted: boolean; promotedId?: string } {
    if (!this.session) return { promoted: false }

    const clientIndex = this.session.clients.findIndex((c) => c.id === clientId)
    if (clientIndex === -1) return { promoted: false }

    const removedClient = this.session.clients[clientIndex]
    this.session.clients.splice(clientIndex, 1)
    this.signalListeners.delete(clientId)

    if (removedClient.role === "controller" && this.session.clients.length > 0) {
      this.session.clients[0].role = "controller"
      return { promoted: true, promotedId: this.session.clients[0].id }
    }

    return { promoted: false }
  }

  getClientRole(clientId: string): ClientRole | null {
    const client = this.session?.clients.find((c) => c.id === clientId)
    return client?.role ?? null
  }

  toggleControlLock(): boolean {
    if (this.session) {
      this.session.controlLocked = !this.session.controlLocked
      return this.session.controlLocked
    }
    return false
  }

  addSignalListener(targetId: string, listener: SignalListener): () => void {
    const listeners = this.signalListeners.get(targetId) || []
    listeners.push(listener)
    this.signalListeners.set(targetId, listeners)

    return () => {
      const current = this.signalListeners.get(targetId) || []
      this.signalListeners.set(
        targetId,
        current.filter((l) => l !== listener)
      )
    }
  }

  sendSignal(message: SignalMessage): void {
    const listeners = this.signalListeners.get(message.to) || []
    for (const listener of listeners) {
      listener(message)
    }
  }
}

const globalForStore = globalThis as unknown as { sessionStore: SessionStore }
export const sessionStore = globalForStore.sessionStore || new SessionStore()
globalForStore.sessionStore = sessionStore
