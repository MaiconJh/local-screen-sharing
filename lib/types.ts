export type ClientRole = "controller" | "viewer"

export interface ConnectedClient {
  id: string
  role: ClientRole
  connectedAt: number
}

export interface Session {
  id: string
  token: string
  hostId: string
  active: boolean
  createdAt: number
  clients: ConnectedClient[]
  maxClients: 2
  controlLocked: boolean
}

export interface SignalMessage {
  type: "offer" | "answer" | "ice-candidate" | "renegotiate"
  from: string
  to: string
  sessionId: string
  payload: unknown
}

export interface StreamStats {
  resolution: string
  fps: number
  bitrate: number
  rtt: number
  packetLoss: number
  jitter: number
  cpuUsage: number
  gpuUsage: number
  timestamp: number
}

export interface StreamConfig {
  role: ClientRole
  maxBitrate: number
  minBitrate: number
  targetFps: number
  targetWidth: number
  targetHeight: number
  keyframeInterval: number
  bufferMs: number
}

export const CONTROLLER_STREAM_CONFIG: StreamConfig = {
  role: "controller",
  maxBitrate: 6_000_000,
  minBitrate: 1_500_000,
  targetFps: 60,
  targetWidth: 1280,
  targetHeight: 720,
  keyframeInterval: 2,
  bufferMs: 0,
}

export const VIEWER_STREAM_CONFIG: StreamConfig = {
  role: "viewer",
  maxBitrate: 10_000_000,
  minBitrate: 2_000_000,
  targetFps: 60,
  targetWidth: 1920,
  targetHeight: 1080,
  keyframeInterval: 1,
  bufferMs: 500,
}

export interface InputEvent {
  type: "mousemove" | "mousedown" | "mouseup" | "wheel" | "keydown" | "keyup"
  x?: number
  y?: number
  button?: number
  deltaX?: number
  deltaY?: number
  key?: string
  code?: string
  modifiers?: {
    ctrl: boolean
    shift: boolean
    alt: boolean
    meta: boolean
  }
  timestamp: number
}

export interface SessionStatus {
  active: boolean
  clientCount: number
  controlLocked: boolean
}
