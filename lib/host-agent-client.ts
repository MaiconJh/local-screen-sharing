export type AgentLatencyProfile = "low-latency" | "balanced"
export type AgentDisplayMode = "extend" | "unknown"
export type AgentDisplayOrientation = "landscape" | "portrait"

export interface AgentDisplayProfile {
  width: number
  height: number
  refreshHz: number
  dpi: number
  scalePercent: number
  colorDepth: number
  monitorId: number
  orientation: AgentDisplayOrientation
}

export interface AgentDisplayProfileRange {
  min: number
  max: number
}

export interface AgentDisplayProfileCapabilities {
  width: AgentDisplayProfileRange
  height: AgentDisplayProfileRange
  refreshHz: AgentDisplayProfileRange
  dpi: AgentDisplayProfileRange
  scalePercent: AgentDisplayProfileRange
  colorDepth: AgentDisplayProfileRange
  monitorId: AgentDisplayProfileRange
  orientation: AgentDisplayOrientation[]
}

export interface AgentDisplayDetectedMode {
  width: number
  height: number
  hz: number
  bitDepth: number
  current: boolean
}

export interface AgentDisplayStatus {
  provider?: string
  available?: boolean
  active?: boolean
  mode?: AgentDisplayMode
  profile?: AgentDisplayProfile
  detectedMonitorIds?: number[]
  detectedModes?: AgentDisplayDetectedMode[]
  targetMonitorFound?: boolean | null
  lastError?: string | null
  lastActionAt?: number | null
  lastOutput?: string | null
}

export interface HostAgentStatusResponse {
  running?: boolean
  version?: string
  captureMode?: "virtual-display" | "desktop-capture" | "unknown"
  display?: AgentDisplayStatus
}

export interface HostAgentStartSessionPayload {
  sessionId: string
  token: string
  hostId: string
  profile: AgentLatencyProfile
  displayProfile?: Partial<AgentDisplayProfile>
  skipDisplayEnsure?: boolean
}

export interface AgentHealth {
  available: boolean
  running: boolean
  version?: string
  captureMode?: "virtual-display" | "desktop-capture" | "unknown"
  display?: AgentDisplayStatus
}

export interface AgentStartSessionResponse {
  success?: boolean
  status?: HostAgentStatusResponse
  displayEnsure?: {
    success?: boolean
    status?: AgentDisplayStatus
    error?: string
  } | null
}

export interface AgentDisplayProfileResponse {
  success?: boolean
  profile?: AgentDisplayProfile
  capabilities?: AgentDisplayProfileCapabilities
  configureSupported?: boolean
  configureReason?: string | null
  status?: AgentDisplayStatus
  configure?: {
    success?: boolean
    applied?: boolean
    warning?: string
    error?: string
    status?: AgentDisplayStatus
  } | null
}

interface AgentRequestInit extends RequestInit {
  timeoutMs?: number
}

export class HostAgentClient {
  constructor(private readonly baseUrl = "/api/host-agent") {}

  private async request<T>(path: string, init?: AgentRequestInit): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), init?.timeoutMs ?? 1200)
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(init?.headers || {}),
        },
      })
      const text = await response.text()
      let parsed: unknown = null
      if (text) {
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = null
        }
      }
      if (!response.ok) {
        const payload = parsed as { error?: string } | null
        throw new Error(payload?.error || `Host agent request failed (${response.status})`)
      }
      return (parsed || {}) as T
    } finally {
      clearTimeout(timeout)
    }
  }

  async getHealth(): Promise<AgentHealth> {
    try {
      const data = await this.request<HostAgentStatusResponse>("/status", { method: "GET", timeoutMs: 900 })
      return {
        available: true,
        running: data.running ?? false,
        version: data.version,
        captureMode: data.captureMode ?? "unknown",
        display: data.display,
      }
    } catch {
      return {
        available: false,
        running: false,
        captureMode: "unknown",
      }
    }
  }

  async startSession(payload: HostAgentStartSessionPayload): Promise<AgentStartSessionResponse> {
    return await this.request<AgentStartSessionResponse>("/session/start", {
      method: "POST",
      body: JSON.stringify(payload),
      timeoutMs: 9000,
    })
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.request("/session/stop", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
      timeoutMs: 1200,
    })
  }

  async ensureDisplay(mode: AgentDisplayMode = "extend"): Promise<AgentDisplayStatus> {
    const data = await this.request<{ success?: boolean; status?: AgentDisplayStatus; error?: string }>(
      "/display/ensure",
      {
        method: "POST",
        body: JSON.stringify({ mode }),
        timeoutMs: 3500,
      }
    )
    if (!data.success || !data.status) {
      throw new Error(data.error || "Failed to ensure display")
    }
    return data.status
  }

  async releaseDisplay(): Promise<AgentDisplayStatus> {
    const data = await this.request<{ success?: boolean; status?: AgentDisplayStatus; error?: string }>(
      "/display/release",
      {
        method: "POST",
        body: JSON.stringify({}),
        timeoutMs: 3500,
      }
    )
    if (!data.success || !data.status) {
      throw new Error(data.error || "Failed to release display")
    }
    return data.status
  }

  async getDisplayStatus(): Promise<AgentDisplayStatus> {
    const data = await this.request<AgentDisplayStatus>("/display/status", {
      method: "GET",
      timeoutMs: 1200,
    })
    return data
  }

  async probeDisplay(): Promise<AgentDisplayStatus> {
    const data = await this.request<{ success?: boolean; status?: AgentDisplayStatus; error?: string }>(
      "/display/probe",
      {
        method: "POST",
        body: JSON.stringify({}),
        timeoutMs: 9000,
      }
    )
    if (!data.success || !data.status) {
      throw new Error(data.error || "Failed to probe display provider")
    }
    return data.status
  }

  async getDisplayProfile(): Promise<AgentDisplayProfileResponse> {
    const data = await this.request<AgentDisplayProfileResponse>("/display/profile", {
      method: "GET",
      timeoutMs: 1200,
    })
    return data
  }

  async setDisplayProfile(
    profile: Partial<AgentDisplayProfile>,
    options?: { applyNow?: boolean }
  ): Promise<AgentDisplayProfileResponse> {
    const data = await this.request<AgentDisplayProfileResponse>("/display/profile", {
      method: "POST",
      body: JSON.stringify({
        profile,
        applyNow: Boolean(options?.applyNow),
      }),
      timeoutMs: options?.applyNow ? 9000 : 4500,
    })
    if (!data.success) {
      throw new Error(data.configure?.error || "Failed to update display profile")
    }
    return data
  }

  async configureDisplay(profile?: Partial<AgentDisplayProfile>): Promise<AgentDisplayProfileResponse> {
    const data = await this.request<AgentDisplayProfileResponse>("/display/configure", {
      method: "POST",
      body: JSON.stringify(profile ? { profile } : {}),
      timeoutMs: 9000,
    })
    if (!data.success) {
      const payload = data as AgentDisplayProfileResponse & { error?: string }
      throw new Error(payload.error || data.configure?.error || "Failed to configure display profile")
    }
    return data
  }
}

export const hostAgentClient = new HostAgentClient()
