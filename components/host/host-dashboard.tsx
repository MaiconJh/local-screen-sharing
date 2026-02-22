"use client"

import { useState, useCallback, useRef, useEffect } from "react"
import useSWR from "swr"
import { QRCodeSVG } from "qrcode.react"
import {
  Monitor,
  Wifi,
  WifiOff,
  Play,
  Square,
  Lock,
  Unlock,
  Copy,
  Check,
  Users,
  Radio,
  Eye,
  Gamepad2,
  Activity,
  Zap,
  ArrowUpRight,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip"
import { StreamMetricsCard } from "./stream-metrics-card"
import { AdvancedPanel } from "./advanced-panel"
import type { ClientRole, StreamStats } from "@/lib/types"
import { CONTROLLER_STREAM_CONFIG, VIEWER_STREAM_CONFIG } from "@/lib/types"
import {
  hostAgentClient,
  type AgentDisplayProfile,
  type AgentDisplayProfileCapabilities,
  type AgentDisplayStatus,
  type AgentHealth,
} from "@/lib/host-agent-client"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

function generateId() {
  return Math.random().toString(36).substring(2, 10) + Date.now().toString(36)
}

type HostStreamState = "idle" | "starting" | "awaiting-clients" | "streaming" | "degraded" | "stopping" | "error"
type PeerStatus = RTCPeerConnectionState | "idle"
type LatencyProfile = "low-latency" | "balanced"
type LinkHealth = "unknown" | "good" | "fair" | "poor"
type AgentStatus = "checking" | "available" | "unavailable"
type AgentCaptureMode = "virtual-display" | "desktop-capture" | "unknown"

type AgentStreamEvent =
  | { type: "connected"; timestamp: number }
  | {
    type: "status"
    status: {
      running?: boolean
      version?: string
      captureMode?: AgentCaptureMode
      display?: AgentDisplayStatus
    }
  }
  | {
    type: "telemetry"
    telemetry: {
      timestamp?: number
      uptimeMs?: number
      sessionRunning?: boolean
      rssBytes?: number
      heapUsedBytes?: number
    }
  }

const STREAM_STATE_LABEL: Record<HostStreamState, string> = {
  idle: "STOPPED",
  starting: "STARTING",
  "awaiting-clients": "AWAITING CLIENTS",
  streaming: "LIVE",
  degraded: "DEGRADED",
  stopping: "STOPPING",
  error: "ERROR",
}

const LINK_HEALTH_LABEL: Record<LinkHealth, string> = {
  unknown: "UNKNOWN",
  good: "GOOD",
  fair: "FAIR",
  poor: "POOR",
}

const DEFAULT_DISPLAY_PROFILE: AgentDisplayProfile = {
  width: 1920,
  height: 1080,
  refreshHz: 60,
  dpi: 96,
  scalePercent: 100,
  colorDepth: 8,
  monitorId: 2,
  orientation: "landscape",
}

const DEFAULT_DISPLAY_PROFILE_CAPABILITIES: AgentDisplayProfileCapabilities = {
  width: { min: 640, max: 7680 },
  height: { min: 360, max: 4320 },
  refreshHz: { min: 24, max: 240 },
  dpi: { min: 72, max: 400 },
  scalePercent: { min: 50, max: 300 },
  colorDepth: { min: 6, max: 16 },
  monitorId: { min: 1, max: 16 },
  orientation: ["landscape", "portrait"],
}

function modeKey(mode: { width: number; height: number; hz: number }) {
  return `${mode.width}x${mode.height}@${mode.hz}`
}

function profileModeSupported(
  modes: Array<{ width: number; height: number; hz: number }>,
  profile: Pick<AgentDisplayProfile, "width" | "height" | "refreshHz">
) {
  return modes.some(
    (mode) => mode.width === profile.width && mode.height === profile.height && mode.hz === profile.refreshHz
  )
}

function clampDisplayInput(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

function normalizeDraftProfile(
  profile: AgentDisplayProfile,
  capabilities?: AgentDisplayProfileCapabilities | null
): AgentDisplayProfile {
  const range = capabilities || DEFAULT_DISPLAY_PROFILE_CAPABILITIES
  const orientation = profile.orientation === "portrait" ? "portrait" : "landscape"
  return {
    width: clampDisplayInput(profile.width, range.width.min, range.width.max),
    height: clampDisplayInput(profile.height, range.height.min, range.height.max),
    refreshHz: clampDisplayInput(profile.refreshHz, range.refreshHz.min, range.refreshHz.max),
    dpi: clampDisplayInput(profile.dpi, range.dpi.min, range.dpi.max),
    scalePercent: clampDisplayInput(profile.scalePercent, range.scalePercent.min, range.scalePercent.max),
    colorDepth: clampDisplayInput(profile.colorDepth, range.colorDepth.min, range.colorDepth.max),
    monitorId: clampDisplayInput(profile.monitorId, range.monitorId.min, range.monitorId.max),
    orientation,
  }
}

function resolveModeManagementSupport(payload: {
  modeManagementSupported?: boolean
  modeManagementReason?: string | null
  addModeSupported?: boolean
  addModeReason?: string | null
  removeModeSupported?: boolean
  removeModeReason?: string | null
}) {
  const supported =
    typeof payload.modeManagementSupported === "boolean"
      ? payload.modeManagementSupported
      : typeof payload.addModeSupported === "boolean" || typeof payload.removeModeSupported === "boolean"
        ? Boolean(payload.addModeSupported && payload.removeModeSupported)
        : null
  const reason =
    payload.modeManagementReason
    || payload.addModeReason
    || payload.removeModeReason
    || null
  return { supported, reason }
}

export function HostDashboard() {
  const [hostId] = useState(() => generateId())
  const [isSharing, setIsSharing] = useState(false)
  const [streamState, setStreamState] = useState<HostStreamState>("idle")
  const [latencyProfile, setLatencyProfile] = useState<LatencyProfile>("low-latency")
  const [autoTune, setAutoTune] = useState(true)
  const [useHostAgent, setUseHostAgent] = useState(false)
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("checking")
  const [agentStreamConnected, setAgentStreamConnected] = useState(false)
  const [agentStreamRetry, setAgentStreamRetry] = useState(0)
  const [agentLastEventAt, setAgentLastEventAt] = useState<number | null>(null)
  const [agentMemoryMb, setAgentMemoryMb] = useState<number | null>(null)
  const [displayActionBusy, setDisplayActionBusy] = useState<
    "none" | "ensure" | "release" | "refresh" | "probe" | "save-profile" | "apply-profile" | "add-mode" | "remove-mode"
  >("none")
  const [displayProfile, setDisplayProfile] = useState<AgentDisplayProfile>(DEFAULT_DISPLAY_PROFILE)
  const [displayProfileCapabilities, setDisplayProfileCapabilities] = useState<AgentDisplayProfileCapabilities | null>(null)
  const [displayConfigureSupported, setDisplayConfigureSupported] = useState<boolean | null>(null)
  const [displayConfigureReason, setDisplayConfigureReason] = useState<string | null>(null)
  const [displayModeManageSupported, setDisplayModeManageSupported] = useState<boolean | null>(null)
  const [displayModeManageReason, setDisplayModeManageReason] = useState<string | null>(null)
  const [displayProfileDirty, setDisplayProfileDirty] = useState(false)
  const [agentHealth, setAgentHealth] = useState<AgentHealth>({
    available: false,
    running: false,
    captureMode: "unknown",
  })
  const [agentMessage, setAgentMessage] = useState<string | null>(null)
  const [sessionToken, setSessionToken] = useState<string | null>(null)
  const [sessionAccessCode, setSessionAccessCode] = useState<string | null>(null)
  const [sessionHostLabel, setSessionHostLabel] = useState<string>("Host")
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [advancedStream, setAdvancedStream] = useState<"controller" | "viewer" | null>(null)

  const mediaStreamRef = useRef<MediaStream | null>(null)
  const controllerPCRef = useRef<RTCPeerConnection | null>(null)
  const viewerPCRef = useRef<RTCPeerConnection | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const agentEventSourceRef = useRef<EventSource | null>(null)
  const displayProfileDirtyRef = useRef(false)
  const connectedClientIdsRef = useRef<Set<string>>(new Set())
  const pendingOfferClientIdsRef = useRef<Set<string>>(new Set())
  const clientRolesRef = useRef<Map<string, ClientRole>>(new Map())
  const reconnectCooldownRef = useRef<Map<string, number>>(new Map())
  const appliedTargetsRef = useRef<Record<ClientRole, { bitrate: number; fps: number; scale: number } | null>>({
    controller: null,
    viewer: null,
  })
  const pendingRemoteIceByRoleRef = useRef<Record<ClientRole, RTCIceCandidateInit[]>>({
    controller: [],
    viewer: [],
  })
  const lastViewerAutoApplyRef = useRef<number>(0)

  const [controllerStats, setControllerStats] = useState<StreamStats[]>([])
  const [viewerStats, setViewerStats] = useState<StreamStats[]>([])
  const [peerStatus, setPeerStatus] = useState<Record<ClientRole, PeerStatus>>({
    controller: "idle",
    viewer: "idle",
  })
  const [linkHealth, setLinkHealth] = useState<Record<ClientRole, LinkHealth>>({
    controller: "unknown",
    viewer: "unknown",
  })

  const { data: sessionData, mutate } = useSWR(
    isSharing ? "/api/session" : null,
    fetcher,
    { refreshInterval: 1000 }
  )

  const joinUrl = sessionToken
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/join?token=${sessionToken}${sessionAccessCode ? `&code=${sessionAccessCode}` : ""}`
    : ""

  const getScreenShareSupportError = () => {
    if (typeof window === "undefined" || typeof navigator === "undefined") {
      return "Screen sharing is not available in this runtime."
    }
    if (!window.isSecureContext) {
      return "Screen sharing requires HTTPS or http://localhost."
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== "function") {
      return "This browser does not support screen sharing."
    }
    return null
  }

  const refreshAgentHealth = useCallback(async () => {
    const status = await hostAgentClient.getHealth()
    setAgentHealth(status)
    setAgentStatus(status.available ? "available" : "unavailable")
    if (status.display?.profile && !displayProfileDirtyRef.current) {
      setDisplayProfile(status.display.profile)
    }
    syncDisplayManageMetadataFromStatus(status.display)
    return status
  }, [])

  const refreshDisplayStatus = useCallback(async () => {
    const display = await hostAgentClient.getDisplayStatus()
    setAgentHealth((prev) => ({ ...prev, available: true, display }))
    setAgentStatus("available")
    if (display.profile && !displayProfileDirtyRef.current) {
      setDisplayProfile(display.profile)
    }
    syncDisplayManageMetadataFromStatus(display)
    return display
  }, [])

  const refreshDisplayProfile = useCallback(async () => {
    const data = await hostAgentClient.getDisplayProfile()
    if (data.capabilities) {
      setDisplayProfileCapabilities(data.capabilities)
    }
    if (typeof data.configureSupported === "boolean") {
      setDisplayConfigureSupported(data.configureSupported)
      setDisplayConfigureReason(data.configureReason || null)
    }
    const modeManageMeta = resolveModeManagementSupport(data)
    if (typeof modeManageMeta.supported === "boolean") {
      setDisplayModeManageSupported(modeManageMeta.supported)
      setDisplayModeManageReason(modeManageMeta.reason)
    }
    if (data.profile && !displayProfileDirtyRef.current) {
      setDisplayProfile(data.profile)
    }
    if (data.status) {
      setAgentHealth((prev) => ({ ...prev, available: true, display: data.status }))
    }
    setAgentStatus("available")
    return data
  }, [])

  function syncDisplayManageMetadataFromStatus(status?: AgentDisplayStatus) {
    if (!status) return
    const modeManageMeta = resolveModeManagementSupport(status)
    if (typeof modeManageMeta.supported === "boolean") {
      setDisplayModeManageSupported(modeManageMeta.supported)
      setDisplayModeManageReason(modeManageMeta.reason)
    }
  }

  const updateDisplayDraft = useCallback(
    (patch: Partial<AgentDisplayProfile>) => {
      setDisplayProfile((prev) => {
        const merged = {
          ...prev,
          ...patch,
        } as AgentDisplayProfile
        return normalizeDraftProfile(merged, displayProfileCapabilities)
      })
      displayProfileDirtyRef.current = true
      setDisplayProfileDirty(true)
    },
    [displayProfileCapabilities]
  )

  const saveDisplayProfile = useCallback(async (applyNow: boolean) => {
    if (applyNow && displayConfigureSupported === false) {
      setAgentMessage(displayConfigureReason || "This display provider cannot apply resolution/DPI settings.")
      return
    }
    if (applyNow) {
      const targetMonitorFound = agentHealth.display?.targetMonitorFound
      const detectedModes = agentHealth.display?.detectedModes || []
      if (targetMonitorFound === false) {
        setAgentMessage(`Target monitor ${displayProfile.monitorId} not detected. Run Probe Provider first.`)
        return
      }
      if (detectedModes.length > 0) {
        const supported = profileModeSupported(detectedModes, displayProfile)
        if (!supported) {
          if (displayModeManageSupported === false) {
            setAgentMessage(
              `Mode ${displayProfile.width}x${displayProfile.height}@${displayProfile.refreshHz}Hz is not available on monitor ${displayProfile.monitorId}. ${displayModeManageReason || "This provider cannot add custom modes."}`
            )
            return
          }
        }
      }
    }
    setDisplayActionBusy(applyNow ? "apply-profile" : "save-profile")
    try {
      const normalizedProfile = normalizeDraftProfile(displayProfile, displayProfileCapabilities)
      if (applyNow) {
        const detectedModes = agentHealth.display?.detectedModes || []
        const supported = profileModeSupported(detectedModes, normalizedProfile)
        if (detectedModes.length > 0 && !supported) {
          const modeResult = await hostAgentClient.addDisplayMode(normalizedProfile)
          if (typeof modeResult.supported === "boolean") {
            setDisplayModeManageSupported(modeResult.supported)
            setDisplayModeManageReason(modeResult.reason || null)
          }
          if (modeResult.status) {
            setAgentHealth((prev) => ({ ...prev, available: true, display: modeResult.status }))
            syncDisplayManageMetadataFromStatus(modeResult.status)
          }
        }
      }
      const data = await hostAgentClient.setDisplayProfile(normalizedProfile, { applyNow })
      if (data.profile) {
        setDisplayProfile(data.profile)
      }
      if (data.capabilities) {
        setDisplayProfileCapabilities(data.capabilities)
      }
      if (typeof data.configureSupported === "boolean") {
        setDisplayConfigureSupported(data.configureSupported)
        setDisplayConfigureReason(data.configureReason || null)
      }
      if (data.status) {
        setAgentHealth((prev) => ({ ...prev, available: true, display: data.status }))
        syncDisplayManageMetadataFromStatus(data.status)
      } else if (data.profile) {
        setAgentHealth((prev) => ({
          ...prev,
          available: true,
          display: {
            ...(prev.display || {}),
            profile: data.profile,
          },
        }))
      }
      setAgentStatus("available")

      let keepDraftDirty = false
      if (applyNow) {
        try {
          const probeStatus = await hostAgentClient.probeDisplay()
          setAgentHealth((prev) => ({ ...prev, available: true, display: probeStatus }))
          syncDisplayManageMetadataFromStatus(probeStatus)

          const currentDetectedMode = (probeStatus.detectedModes || []).find((mode) => mode.current)
          if (probeStatus.targetMonitorFound === false) {
            keepDraftDirty = true
            setAgentMessage(`Display profile saved, but target monitor ${normalizedProfile.monitorId} is not currently detected.`)
          } else if (currentDetectedMode) {
            const currentMatchesDraft =
              currentDetectedMode.width === normalizedProfile.width
              && currentDetectedMode.height === normalizedProfile.height
              && currentDetectedMode.hz === normalizedProfile.refreshHz
              && currentDetectedMode.bitDepth === normalizedProfile.colorDepth
            if (!currentMatchesDraft) {
              keepDraftDirty = true
              setAgentMessage(
                `Display profile saved, but active mode is ${currentDetectedMode.width}x${currentDetectedMode.height}@${currentDetectedMode.hz}Hz ${currentDetectedMode.bitDepth}bit (requested ${normalizedProfile.width}x${normalizedProfile.height}@${normalizedProfile.refreshHz}Hz ${normalizedProfile.colorDepth}bit).`
              )
            }
          }
        } catch {
          // keep previous success path when probe is unavailable
        }
      }

      displayProfileDirtyRef.current = keepDraftDirty
      setDisplayProfileDirty(keepDraftDirty)

      if (applyNow && data.configure?.applied === false) {
        setAgentMessage(data.configure.warning || "Display profile saved. Provider has no configure command.")
      } else if (!keepDraftDirty) {
        setAgentMessage(applyNow ? "Display profile saved and applied." : "Display profile saved.")
      }
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : (applyNow ? "Failed to apply display profile." : "Failed to save display profile.")
      setAgentMessage(message)
    } finally {
      setDisplayActionBusy("none")
    }
  }, [agentHealth.display, displayConfigureReason, displayConfigureSupported, displayModeManageReason, displayModeManageSupported, displayProfile, displayProfileCapabilities])

  const setDisplayProfileNumberField = useCallback(
    (
      field: "width" | "height" | "refreshHz" | "dpi" | "scalePercent" | "colorDepth" | "monitorId",
      raw: string
    ) => {
      if (raw.trim() === "") return
      const parsed = Number(raw)
      if (!Number.isFinite(parsed)) return
      updateDisplayDraft({ [field]: parsed } as Partial<AgentDisplayProfile>)
    },
    [updateDisplayDraft]
  )

  const selectDetectedDisplayMode = useCallback((value: string) => {
    if (value === "__custom__") return
    const [resolutionPart, rest] = value.split("@")
    const [widthText, heightText] = resolutionPart.split("x")
    const [hzText] = (rest || "").split(":")
    const width = Number(widthText)
    const height = Number(heightText)
    const hz = Number(hzText)
    if (!Number.isFinite(width) || !Number.isFinite(height)) return
    if (!Number.isFinite(hz)) return
    updateDisplayDraft({
      width,
      height,
      refreshHz: hz,
    })
  }, [updateDisplayDraft])

  const ensureDisplay = useCallback(async () => {
    setDisplayActionBusy("ensure")
    try {
      const display = await hostAgentClient.ensureDisplay("extend")
      setAgentHealth((prev) => ({ ...prev, available: true, display }))
      syncDisplayManageMetadataFromStatus(display)
      if (display.profile && !displayProfileDirtyRef.current) {
        setDisplayProfile(display.profile)
      }
      setAgentStatus("available")
      setAgentMessage(display.active
        ? "Display expanded in extend mode."
        : "Display ensure command executed, but display is inactive.")
    } catch {
      setAgentMessage("Failed to expand display via Host Agent.")
    } finally {
      setDisplayActionBusy("none")
    }
  }, [])

  const releaseDisplay = useCallback(async () => {
    setDisplayActionBusy("release")
    try {
      const display = await hostAgentClient.releaseDisplay()
      setAgentHealth((prev) => ({ ...prev, available: true, display }))
      syncDisplayManageMetadataFromStatus(display)
      if (display.profile && !displayProfileDirtyRef.current) {
        setDisplayProfile(display.profile)
      }
      setAgentStatus("available")
      setAgentMessage("Display returned to internal mode.")
    } catch {
      setAgentMessage("Failed to release display via Host Agent.")
    } finally {
      setDisplayActionBusy("none")
    }
  }, [])

  const refreshDisplay = useCallback(async () => {
    setDisplayActionBusy("refresh")
    try {
      const display = await refreshDisplayStatus()
      if (display.lastError) {
        setAgentMessage(`Display status warning: ${display.lastError}`)
      }
    } catch {
      setAgentMessage("Failed to refresh display status.")
    } finally {
      setDisplayActionBusy("none")
    }
  }, [refreshDisplayStatus])

  const probeDisplay = useCallback(async () => {
    setDisplayActionBusy("probe")
    try {
      const display = await hostAgentClient.probeDisplay()
      setAgentHealth((prev) => ({ ...prev, available: true, display }))
      syncDisplayManageMetadataFromStatus(display)
      if (display.profile && !displayProfileDirtyRef.current) {
        setDisplayProfile(display.profile)
      }
      setAgentStatus("available")
      setAgentMessage(display.available
        ? "Display provider probe successful."
        : "Display provider probe finished with unavailable state.")
    } catch {
      setAgentMessage("Display provider probe failed.")
    } finally {
      setDisplayActionBusy("none")
    }
  }, [])

  const addDisplayMode = useCallback(async () => {
    setDisplayActionBusy("add-mode")
    try {
      const data = await hostAgentClient.addDisplayMode(displayProfile)
      if (typeof data.supported === "boolean") {
        setDisplayModeManageSupported(data.supported)
        setDisplayModeManageReason(data.reason || null)
      }
      if (data.status) {
        setAgentHealth((prev) => ({ ...prev, available: true, display: data.status }))
        syncDisplayManageMetadataFromStatus(data.status)
      }
      setAgentStatus("available")
      setAgentMessage(data.reason || "Display mode added on provider.")
    } catch (error) {
      setAgentMessage(error instanceof Error ? error.message : "Failed to add display mode.")
    } finally {
      setDisplayActionBusy("none")
    }
  }, [displayProfile])

  const removeDisplayMode = useCallback(async () => {
    setDisplayActionBusy("remove-mode")
    try {
      const data = await hostAgentClient.removeDisplayMode(displayProfile)
      if (typeof data.supported === "boolean") {
        setDisplayModeManageSupported(data.supported)
        setDisplayModeManageReason(data.reason || null)
      }
      if (data.status) {
        setAgentHealth((prev) => ({ ...prev, available: true, display: data.status }))
        syncDisplayManageMetadataFromStatus(data.status)
      }
      setAgentStatus("available")
      setAgentMessage(data.reason || "Display mode removed from provider.")
    } catch (error) {
      setAgentMessage(error instanceof Error ? error.message : "Failed to remove display mode.")
    } finally {
      setDisplayActionBusy("none")
    }
  }, [displayProfile])

  const toCaptureMode = useCallback((value: unknown): AgentCaptureMode => {
    if (value === "virtual-display" || value === "desktop-capture") return value
    return "unknown"
  }, [])

  const getBaseTargets = useCallback((role: ClientRole) => {
    const cfg = role === "controller" ? CONTROLLER_STREAM_CONFIG : VIEWER_STREAM_CONFIG
    if (latencyProfile === "low-latency") {
      return {
        maxBitrate: role === "controller" ? 4_500_000 : 7_000_000,
        minBitrate: role === "controller" ? 1_200_000 : 1_800_000,
        maxFramerate: role === "controller" ? 60 : 50,
        minFramerate: role === "controller" ? 30 : 24,
      }
    }
    return {
      maxBitrate: cfg.maxBitrate,
      minBitrate: cfg.minBitrate,
      maxFramerate: cfg.targetFps,
      minFramerate: role === "controller" ? 30 : 24,
    }
  }, [latencyProfile])

  const setSenderTargets = useCallback(async (
    role: ClientRole,
    targets: { bitrate: number; fps: number; scale: number }
  ) => {
    const pc = role === "controller" ? controllerPCRef.current : viewerPCRef.current
    if (!pc) return
    const sender = pc.getSenders().find((s) => s.track?.kind === "video")
    if (!sender) return

    const last = appliedTargetsRef.current[role]
    if (
      last &&
      Math.abs(last.bitrate - targets.bitrate) < 150_000 &&
      Math.abs(last.fps - targets.fps) <= 1 &&
      Math.abs(last.scale - targets.scale) < 0.05
    ) {
      return
    }

    const params = sender.getParameters()
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}]
    }
    const encoding = params.encodings[0]
    encoding.maxBitrate = Math.max(250_000, Math.round(targets.bitrate))
    encoding.maxFramerate = Math.max(10, Math.round(targets.fps))
    encoding.scaleResolutionDownBy = Math.max(1, targets.scale)
    encoding.priority = role === "controller" ? "high" : "medium"

    try {
      await sender.setParameters(params)
      appliedTargetsRef.current[role] = {
        bitrate: encoding.maxBitrate,
        fps: encoding.maxFramerate,
        scale: encoding.scaleResolutionDownBy,
      }
    } catch {
      // Ignore unsupported parameter combinations per browser/device.
    }
  }, [])

  const applyAdaptiveTargets = useCallback(async (role: ClientRole, stats: StreamStats) => {
    const base = getBaseTargets(role)
    const loss = Math.min(1, Math.max(0, stats.packetLoss))

    let health: LinkHealth = "good"
    let bitrate = base.maxBitrate
    let fps = base.maxFramerate
    let scale = 1

    if (loss > 0.03 || stats.rtt > 85 || stats.jitter > 28) {
      health = "poor"
      bitrate = Math.max(base.minBitrate, Math.floor(base.maxBitrate * 0.5))
      fps = Math.max(base.minFramerate, Math.floor(base.maxFramerate * 0.6))
      scale = role === "controller" ? 1.5 : 1.75
    } else if (loss > 0.01 || stats.rtt > 45 || stats.jitter > 14) {
      health = "fair"
      bitrate = Math.max(base.minBitrate, Math.floor(base.maxBitrate * 0.72))
      fps = Math.max(base.minFramerate, Math.floor(base.maxFramerate * 0.8))
      scale = role === "controller" ? 1.25 : 1.5
    }

    if (role === "controller" && health !== "poor") {
      fps = Math.max(45, fps)
    }

    setLinkHealth((prev) => (
      prev[role] === health
        ? prev
        : { ...prev, [role]: health }
    ))

    await setSenderTargets(role, { bitrate, fps, scale })
  }, [getBaseTargets, setSenderTargets])

  // Create a peer connection and send an offer to the given client
  const createPeerAndOffer = useCallback(
    async (clientId: string, clientRole: "controller" | "viewer") => {
      if (!mediaStreamRef.current || !sessionId) return
      if (
        connectedClientIdsRef.current.has(clientId) ||
        pendingOfferClientIdsRef.current.has(clientId)
      ) {
        return
      }

      pendingOfferClientIdsRef.current.add(clientId)
      clientRolesRef.current.set(clientId, clientRole)

      const pcRef = clientRole === "controller" ? controllerPCRef : viewerPCRef

      try {
        // Close existing connection if any
        pcRef.current?.close()

        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        })
        pcRef.current = pc
        setPeerStatus((prev) => ({ ...prev, [clientRole]: "connecting" }))
        pendingRemoteIceByRoleRef.current[clientRole] = []

        // Add tracks from media stream
        for (const track of mediaStreamRef.current.getTracks()) {
          pc.addTrack(track, mediaStreamRef.current)
        }

        // For controller, add a data channel for remote input
        if (clientRole === "controller") {
          const dc = pc.createDataChannel("input", { ordered: true })
          dc.onmessage = (event) => {
            // Input events from controller client would be processed here
            // In a real implementation, this would inject input events on the host machine
            void event
          }
        }

        // ICE candidate forwarding
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            fetch("/api/signal", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                type: "ice-candidate",
                from: `host-${hostId}`,
                to: clientId,
                sessionId,
                payload: event.candidate.toJSON(),
              }),
            })
          }
        }

        pc.onconnectionstatechange = () => {
          setPeerStatus((prev) => ({ ...prev, [clientRole]: pc.connectionState }))
          if (pc.connectionState === "connected") {
            reconnectCooldownRef.current.delete(clientId)
            return
          }
          if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
            connectedClientIdsRef.current.delete(clientId)
            mutate()

            const now = Date.now()
            const lastAttempt = reconnectCooldownRef.current.get(clientId) || 0
            if (now - lastAttempt < 1500) return
            reconnectCooldownRef.current.set(clientId, now)

            setTimeout(() => {
              if (!mediaStreamRef.current || !sessionId || !isSharing) return
              void createPeerAndOffer(clientId, clientRole)
            }, 250)
          }
        }

        // Apply bitrate constraints after connection
        pc.oniceconnectionstatechange = () => {
          if (pc.iceConnectionState === "connected") {
            const base = getBaseTargets(clientRole)
            void setSenderTargets(clientRole, {
              bitrate: base.maxBitrate,
              fps: base.maxFramerate,
              scale: 1,
            })
          }
        }

        // Create and send a single offer. Avoid onnegotiationneeded to prevent
        // duplicated/reordered m-lines across concurrent negotiations.
        const offer = await pc.createOffer()
        if (pc.signalingState !== "stable") {
          return
        }
        await pc.setLocalDescription(offer)

        await fetch("/api/signal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "offer",
            from: `host-${hostId}`,
            to: clientId,
            sessionId,
            payload: offer,
          }),
        })

        connectedClientIdsRef.current.add(clientId)
      } catch (err) {
        console.error("[v0] Failed to create peer/offer:", err)
        setPeerStatus((prev) => ({ ...prev, [clientRole]: "failed" }))
      } finally {
        pendingOfferClientIdsRef.current.delete(clientId)
      }
    },
    [getBaseTargets, hostId, isSharing, mutate, sessionId, setSenderTargets]
  )

  const startSharing = useCallback(async () => {
    setStreamState("starting")
    const supportError = getScreenShareSupportError()
    if (supportError) {
      setStartError(supportError)
      setStreamState("error")
      return
    }

    setStartError(null)
    const normalizedProfile = normalizeDraftProfile(displayProfile, displayProfileCapabilities)
    let createdSessionId: string | null = null
    let agentAvailableForStart = false
    let agentSessionStarted = false

    try {
      if (useHostAgent) {
        const status = await refreshAgentHealth()
        if (status.available) {
          agentAvailableForStart = true
          const providerDisabled = status.display?.provider === "none"
          let configureSupport = displayConfigureSupported
          let configureReason = displayConfigureReason

          if (configureSupport === null) {
            try {
              const profileData = await refreshDisplayProfile()
              configureSupport =
                typeof profileData.configureSupported === "boolean"
                  ? profileData.configureSupported
                  : configureSupport
              configureReason = profileData.configureReason || configureReason
            } catch {
              // keep current support state
            }
          }

          if (!providerDisabled && configureSupport === false) {
            setStartError(
              configureReason
              || "Provider sem suporte real para resolucao/DPI. Use custom-cli + HOST_AGENT_DISPLAY_CONFIGURE_CMD."
            )
            setStreamState("error")
            return
          }

          if (displayProfileDirty) {
            if (configureSupport === false) {
              setStartError(
                configureReason
                || "O provider atual nao aplica resolucao/DPI. Use custom-cli + HOST_AGENT_DISPLAY_CONFIGURE_CMD."
              )
            } else {
              setStartError("Salve e aplique o perfil do segundo ecrã antes de iniciar (Save + Apply).")
            }
            setStreamState("error")
            return
          }

          const statusDetectedModes = status.display?.detectedModes || []
          const statusTargetMonitorFound = status.display?.targetMonitorFound
          if (!providerDisabled && statusTargetMonitorFound === false) {
            setStartError(`Monitor alvo ${normalizedProfile.monitorId} nao detectado. Execute Probe Provider e ajuste o monitor.`)
            setStreamState("error")
            return
          }

          if (
            !providerDisabled
            && statusDetectedModes.length > 0
            && !profileModeSupported(statusDetectedModes, normalizedProfile)
            && displayModeManageSupported === false
          ) {
            setStartError(
              `Modo ${normalizedProfile.width}x${normalizedProfile.height}@${normalizedProfile.refreshHz}Hz nao esta nos modos detectados do monitor ${normalizedProfile.monitorId}.`
            )
            setStreamState("error")
            return
          }

          if (!providerDisabled && !status.display?.active) {
            setStartError("Prepare o segundo ecrã antes de iniciar (Save + Apply ou Expand Display).")
            setStreamState("error")
            return
          }
        } else {
          setAgentMessage("Host Agent offline. Running with browser capture.")
        }
      } else {
        setAgentMessage(null)
      }

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 60 },
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })

      mediaStreamRef.current = stream

      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        void stopSharing()
      })

      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", hostId, hostLabel: `Host ${hostId.slice(0, 6)}` }),
      })
      if (!res.ok) {
        throw new Error(`Session creation failed: ${res.status}`)
      }
      const data = await res.json()

      if (data.success) {
        const createdSessionIdValue: string = data.session.id
        const createdToken: string = data.session.token
        createdSessionId = createdSessionIdValue

        if (useHostAgent && agentAvailableForStart) {
          try {
            const startResult = await hostAgentClient.startSession({
              sessionId: createdSessionIdValue,
              token: createdToken,
              hostId,
              profile: latencyProfile,
              displayProfile: normalizedProfile,
              skipDisplayEnsure: true,
            })
            agentSessionStarted = true
            const displayFromStart = startResult.status?.display || startResult.displayEnsure?.status
            if (displayFromStart) {
              setAgentHealth((prev) => ({ ...prev, display: displayFromStart }))
              syncDisplayManageMetadataFromStatus(displayFromStart)
            }
            setAgentMessage("Host Agent session started. Display was prepared before capture.")
          } catch {
            setAgentMessage("Host Agent session start failed. Running with browser signaling only.")
          }
        }

        setSessionToken(data.session.token)
        setSessionAccessCode(data.session.accessCode || null)
        setSessionHostLabel(data.session.hostLabel || `Host ${hostId.slice(0, 6)}`)
        setSessionId(data.session.id)
        setIsSharing(true)
        setStreamState("awaiting-clients")
        setPeerStatus({
          controller: "idle",
          viewer: "idle",
        })
        setLinkHealth({
          controller: "unknown",
          viewer: "unknown",
        })
        appliedTargetsRef.current.controller = null
        appliedTargetsRef.current.viewer = null

        const evtSource = new EventSource(`/api/signal?listenerId=host-${hostId}`)
        eventSourceRef.current = evtSource

        evtSource.onmessage = async (event) => {
          const signal = JSON.parse(event.data)
          if (signal.type === "connected") return
          await handleSignal(signal)
        }

        mutate()
      } else {
        throw new Error("Session creation response was unsuccessful")
      }
    } catch (err) {
      if (createdSessionId) {
        try {
          if (agentSessionStarted) {
            await hostAgentClient.stopSession(createdSessionId)
          }
        } catch {
          // best effort
        }
        try {
          await fetch("/api/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "destroy" }),
          })
        } catch {
          // best effort
        }
      }

      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop())
        mediaStreamRef.current = null
      }

      if (err instanceof DOMException && err.name === "NotAllowedError") {
        setStartError("Screen sharing permission was denied.")
        setStreamState("error")
        return
      }
      console.error("[v0] Failed to start sharing:", err)
      setStartError("Unable to start screen sharing. Check browser support and permissions.")
      setStreamState("error")
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    displayConfigureReason,
    displayConfigureSupported,
    displayProfile,
    displayProfileCapabilities,
    displayProfileDirty,
    hostId,
    latencyProfile,
    mutate,
    refreshAgentHealth,
    refreshDisplayProfile,
    useHostAgent,
  ])

  const handleSignal = useCallback(async (signal: { type: string; from: string; payload: unknown }) => {
    const roleFromRef = clientRolesRef.current.get(signal.from)
    const clients: Array<{ id: string; role: string }> = sessionData?.clients || []
    const roleFromSession = clients.find((c) => c.id === signal.from)?.role as ClientRole | undefined
    const resolvedRole = roleFromRef ?? roleFromSession

    let pc: RTCPeerConnection | null = null
    if (resolvedRole === "controller") {
      pc = controllerPCRef.current
    } else if (resolvedRole === "viewer") {
      pc = viewerPCRef.current
    } else if (signal.type === "answer") {
      pc = [controllerPCRef.current, viewerPCRef.current].find(
        (candidate) => candidate?.signalingState === "have-local-offer"
      ) || null
    } else if (signal.type === "ice-candidate") {
      pc = [controllerPCRef.current, viewerPCRef.current].find(
        (candidate) => !!candidate
      ) || null
    }

    if (signal.type === "viewer-capabilities" && resolvedRole === "viewer") {
      if (!useHostAgent || agentStatus !== "available" || displayConfigureSupported === false) return

      const now = Date.now()
      if (now - lastViewerAutoApplyRef.current < 4000) return
      lastViewerAutoApplyRef.current = now

      const payload = signal.payload as {
        width?: number
        height?: number
        availWidth?: number
        availHeight?: number
      }
      const baseWidth = Number(payload.availWidth || payload.width)
      const baseHeight = Number(payload.availHeight || payload.height)
      if (!Number.isFinite(baseWidth) || !Number.isFinite(baseHeight) || baseWidth < 320 || baseHeight < 240) return

      const normalized = normalizeDraftProfile(
        {
          ...displayProfile,
          width: baseWidth,
          height: baseHeight,
        },
        displayProfileCapabilities
      )

      try {
        setDisplayActionBusy("apply-profile")
        const result = await hostAgentClient.setDisplayProfile(normalized, { applyNow: true })
        if (result.profile) {
          setDisplayProfile(result.profile)
        }
        if (result.status) {
          setAgentHealth((prev) => ({ ...prev, available: true, display: result.status }))
          syncDisplayManageMetadataFromStatus(result.status)
        }
        displayProfileDirtyRef.current = false
        setDisplayProfileDirty(false)
        setAgentMessage(`Display auto-adjusted to viewer resolution ${normalized.width}x${normalized.height}.`)
      } catch {
        setAgentMessage("Viewer connected, but failed to auto-adjust display profile.")
      } finally {
        setDisplayActionBusy("none")
      }
      return
    }

    if (!pc) return
    const roleForPc: ClientRole | undefined =
      resolvedRole
      ?? (pc === controllerPCRef.current ? "controller" : undefined)
      ?? (pc === viewerPCRef.current ? "viewer" : undefined)

    if (signal.type === "answer") {
      try {
        if (pc.signalingState !== "have-local-offer") {
          return
        }
        await pc.setRemoteDescription(
          new RTCSessionDescription(signal.payload as RTCSessionDescriptionInit)
        )

        if (roleForPc) {
          for (const candidate of pendingRemoteIceByRoleRef.current[roleForPc]) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(candidate))
            } catch {
              // ignore invalid/late candidates
            }
          }
          pendingRemoteIceByRoleRef.current[roleForPc] = []
        }
      } catch (err) {
        console.error("[v0] Failed to set remote description:", err)
      }
    } else if (signal.type === "ice-candidate") {
      try {
        const candidate = signal.payload as RTCIceCandidateInit
        if (!pc.remoteDescription) {
          if (roleForPc) {
            pendingRemoteIceByRoleRef.current[roleForPc].push(candidate)
          }
          return
        }
        await pc.addIceCandidate(new RTCIceCandidate(candidate))
      } catch (err) {
        console.error("[v0] Failed to add ICE candidate:", err)
      }
    }
  }, [agentStatus, displayConfigureSupported, displayProfile, displayProfileCapabilities, sessionData, useHostAgent])

  const stopSharing = useCallback(async () => {
    setStreamState("stopping")
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop())
      mediaStreamRef.current = null
    }
    controllerPCRef.current?.close()
    viewerPCRef.current?.close()
    controllerPCRef.current = null
    viewerPCRef.current = null
    connectedClientIdsRef.current.clear()
    pendingOfferClientIdsRef.current.clear()
    clientRolesRef.current.clear()
    reconnectCooldownRef.current.clear()
    appliedTargetsRef.current.controller = null
    appliedTargetsRef.current.viewer = null
    pendingRemoteIceByRoleRef.current.controller = []
    pendingRemoteIceByRoleRef.current.viewer = []
    setPeerStatus({
      controller: "idle",
      viewer: "idle",
    })
    setLinkHealth({
      controller: "unknown",
      viewer: "unknown",
    })

    eventSourceRef.current?.close()
    eventSourceRef.current = null

    if (useHostAgent && sessionId) {
      try {
        await hostAgentClient.stopSession(sessionId)
        try {
          const displayStatus = await hostAgentClient.releaseDisplay()
          setAgentHealth((prev) => ({ ...prev, display: displayStatus }))
          syncDisplayManageMetadataFromStatus(displayStatus)
          if (displayStatus.profile && !displayProfileDirtyRef.current) {
            setDisplayProfile(displayStatus.profile)
          }
        } catch {
          // display release is best-effort
        }
      } catch {
        setAgentMessage("Failed to notify Host Agent to stop session.")
      }
    }

    await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "destroy" }),
    })

    setIsSharing(false)
    setSessionToken(null)
    setSessionAccessCode(null)
    setSessionId(null)
    setControllerStats([])
    setViewerStats([])
    setStartError(null)
    setStreamState("idle")
    if (!useHostAgent) {
      setAgentMessage(null)
    }
    mutate()
  }, [mutate, sessionId, useHostAgent])

  const toggleLock = useCallback(async () => {
    await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "toggle-lock" }),
    })
    mutate()
  }, [mutate])

  const copyUrl = useCallback(() => {
    navigator.clipboard.writeText(joinUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [joinUrl])

  useEffect(() => {
    let disposed = false
    const run = async () => {
      const status = await refreshAgentHealth()
      if (disposed) return
      if (status.available) {
        try {
          await refreshDisplayProfile()
        } catch {
          // Keep running even if profile endpoint is unavailable.
        }
      }
      if (!status.available && useHostAgent) {
        setAgentMessage("Host Agent offline. Running with browser capture.")
      } else if (status.available && !useHostAgent && agentMessage?.includes("Host Agent offline")) {
        setAgentMessage(null)
      }
    }

    void run()
    const interval = setInterval(() => {
      // Keep a fallback health poll even with SSE active.
      if (!agentStreamConnected) {
        void run()
      }
    }, 12000)

    return () => {
      disposed = true
      clearInterval(interval)
    }
  }, [agentMessage, agentStreamConnected, refreshAgentHealth, refreshDisplayProfile, useHostAgent])

  useEffect(() => {
    let disposed = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    const source = new EventSource("/api/host-agent/events")
    agentEventSourceRef.current = source

    source.onopen = () => {
      if (disposed) return
      setAgentStreamConnected(true)
      setAgentStatus("available")
    }

    source.onmessage = (event) => {
      if (disposed) return
      setAgentLastEventAt(Date.now())
      try {
        const payload = JSON.parse(event.data) as AgentStreamEvent
        if (payload.type === "status") {
          if (payload.status.display?.profile && !displayProfileDirtyRef.current) {
            setDisplayProfile(payload.status.display.profile)
          }
          syncDisplayManageMetadataFromStatus(payload.status.display)
          setAgentHealth({
            available: true,
            running: Boolean(payload.status.running),
            version: payload.status.version,
            captureMode: toCaptureMode(payload.status.captureMode),
            display: payload.status.display,
          })
          setAgentStatus("available")
          if (agentMessage && (
            agentMessage.includes("Host Agent offline")
            || agentMessage.includes("stream disconnected")
            || agentMessage.includes("start failed")
          )) {
            setAgentMessage(null)
          }
        } else if (payload.type === "telemetry") {
          const rssBytes = payload.telemetry.rssBytes
          setAgentMemoryMb(
            typeof rssBytes === "number" && rssBytes > 0
              ? Math.round((rssBytes / (1024 * 1024)) * 10) / 10
              : null
          )
        }
      } catch {
        // Ignore malformed event payloads from agent stream.
      }
    }

    source.onerror = () => {
      if (disposed) return
      setAgentStreamConnected(false)
      setAgentStatus("unavailable")
      source.close()
      if (agentEventSourceRef.current === source) {
        agentEventSourceRef.current = null
      }
      if (useHostAgent) {
        setAgentMessage("Host Agent stream disconnected. Reconnecting...")
      }
      reconnectTimer = setTimeout(() => {
        setAgentStreamRetry((prev) => prev + 1)
      }, 1500)
    }

    return () => {
      disposed = true
      setAgentStreamConnected(false)
      source.close()
      if (agentEventSourceRef.current === source) {
        agentEventSourceRef.current = null
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
      }
    }
  }, [agentMessage, agentStreamRetry, toCaptureMode, useHostAgent])

  // Collect WebRTC stats periodically
  useEffect(() => {
    if (!isSharing) return
    const interval = setInterval(async () => {
      const now = Date.now()
      if (controllerPCRef.current) {
        try {
          const stats = await controllerPCRef.current.getStats()
          const s = parseStats(stats, now)
          if (s) {
            setControllerStats((prev) => [...prev.slice(-59), s])
            if (autoTune) {
              void applyAdaptiveTargets("controller", s)
            }
          }
        } catch { /* peer closed */ }
      }
      if (viewerPCRef.current) {
        try {
          const stats = await viewerPCRef.current.getStats()
          const s = parseStats(stats, now)
          if (s) {
            setViewerStats((prev) => [...prev.slice(-59), s])
            if (autoTune) {
              void applyAdaptiveTargets("viewer", s)
            }
          }
        } catch { /* peer closed */ }
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [applyAdaptiveTargets, autoTune, isSharing])

  // Apply the selected profile when settings change.
  useEffect(() => {
    if (!isSharing) return
    const baseController = getBaseTargets("controller")
    const baseViewer = getBaseTargets("viewer")
    void setSenderTargets("controller", {
      bitrate: baseController.maxBitrate,
      fps: baseController.maxFramerate,
      scale: 1,
    })
    void setSenderTargets("viewer", {
      bitrate: baseViewer.maxBitrate,
      fps: baseViewer.maxFramerate,
      scale: 1,
    })
    if (!autoTune) {
      setLinkHealth((prev) => ({
        controller: prev.controller === "unknown" ? prev.controller : "good",
        viewer: prev.viewer === "unknown" ? prev.viewer : "good",
      }))
    }
  }, [autoTune, getBaseTargets, isSharing, setSenderTargets])

  // Watch for new clients joining via SWR poll and create offers
  useEffect(() => {
    if (!isSharing || !sessionData?.clients) return
    const clients: Array<{ id: string; role: string }> = sessionData.clients
    const presentIds = new Set<string>()
    const activeRoles = new Set<ClientRole>()
    for (const client of clients) {
      presentIds.add(client.id)
      const typedRole = client.role as ClientRole
      activeRoles.add(typedRole)
      const previousRole = clientRolesRef.current.get(client.id)
      if (previousRole && previousRole !== typedRole) {
        connectedClientIdsRef.current.delete(client.id)
        setPeerStatus((prev) => ({ ...prev, [previousRole]: "idle" }))
      }
      clientRolesRef.current.set(client.id, client.role as ClientRole)
      if (!connectedClientIdsRef.current.has(client.id)) {
        createPeerAndOffer(client.id, client.role as "controller" | "viewer")
      }
    }
    for (const id of Array.from(clientRolesRef.current.keys())) {
      if (!presentIds.has(id)) {
        reconnectCooldownRef.current.delete(id)
        connectedClientIdsRef.current.delete(id)
        pendingOfferClientIdsRef.current.delete(id)
        clientRolesRef.current.delete(id)
      }
    }
    setPeerStatus((prev) => ({
      controller: activeRoles.has("controller") ? prev.controller : "idle",
      viewer: activeRoles.has("viewer") ? prev.viewer : "idle",
    }))
  }, [isSharing, sessionData, createPeerAndOffer])

  // Keep a lifecycle state that reflects current stream health.
  useEffect(() => {
    if (!isSharing) return
    const clients: Array<{ role: string }> = sessionData?.clients || []
    if (clients.length === 0) {
      if (streamState !== "starting" && streamState !== "stopping") {
        setStreamState("awaiting-clients")
      }
      return
    }

    const roles = new Set(clients.map((c) => c.role as ClientRole))
    const roleStates = Array.from(roles).map((role) => peerStatus[role])
    if (roleStates.some((status) => status === "failed" || status === "disconnected")) {
      setStreamState("degraded")
      return
    }
    if (roleStates.every((status) => status === "connected")) {
      setStreamState("streaming")
      return
    }
    if (roleStates.some((status) => status === "connected")) {
      setStreamState("degraded")
      return
    }
    if (streamState !== "starting" && streamState !== "stopping") {
      setStreamState("awaiting-clients")
    }
  }, [isSharing, peerStatus, sessionData, streamState])

  const clients = sessionData?.clients || []
  const controllerClient = clients.find((c: { role: string }) => c.role === "controller")
  const viewerClient = clients.find((c: { role: string }) => c.role === "viewer")
  const isBusy = streamState === "starting" || streamState === "stopping"
  const stateLabel = STREAM_STATE_LABEL[streamState]
  const stateIsLive = streamState === "streaming" || streamState === "degraded"
  const displayControlsDisabled = agentStatus !== "available" || displayActionBusy !== "none"
  const effectiveDisplayCapabilities = displayProfileCapabilities || DEFAULT_DISPLAY_PROFILE_CAPABILITIES
  const providerName = agentHealth.display?.provider || "unknown"
  const providerConfigureLabel =
    displayConfigureSupported === true
      ? "SUPPORTED"
      : displayConfigureSupported === false
        ? "UNSUPPORTED"
        : "UNKNOWN"
  const providerMode = agentHealth.display?.mode || "unknown"
  const providerModeManageLabel =
    displayModeManageSupported === true
      ? "SUPPORTED"
      : displayModeManageSupported === false
        ? "UNSUPPORTED"
        : "UNKNOWN"
  const detectedModes = agentHealth.display?.detectedModes || []
  const detectedMonitorIds = agentHealth.display?.detectedMonitorIds || []
  const targetMonitorFound = agentHealth.display?.targetMonitorFound
  const displayModeOptions = Array.from(
    new Map(detectedModes.map((mode) => [modeKey(mode), mode])).values()
  )
  const selectedModeKey = modeKey({
    width: displayProfile.width,
    height: displayProfile.height,
    hz: displayProfile.refreshHz,
  })
  const selectedModeDetected = profileModeSupported(displayModeOptions, displayProfile)
  const selectedModeLabel = selectedModeDetected
    ? `${displayProfile.width}x${displayProfile.height} @${displayProfile.refreshHz}Hz ${displayProfile.colorDepth}bit`
    : `Custom ${displayProfile.width}x${displayProfile.height} @${displayProfile.refreshHz}Hz ${displayProfile.colorDepth}bit`
  const modeMissingFromDetectedList = displayModeOptions.length > 0 && !selectedModeDetected
  const invalidDraftModeForDetectedList = modeMissingFromDetectedList && displayModeManageSupported === false
  const saveApplyBlockedByMode = targetMonitorFound === false || invalidDraftModeForDetectedList
  const saveApplyBlockReason =
    targetMonitorFound === false
      ? `Target monitor ${displayProfile.monitorId} not detected.`
      : invalidDraftModeForDetectedList
        ? `Mode ${displayProfile.width}x${displayProfile.height}@${displayProfile.refreshHz}Hz is not available in detected modes and provider cannot add it.`
        : null
  const saveApplyDisabled = displayControlsDisabled || displayConfigureSupported === false || saveApplyBlockedByMode
  const startBlockedByProvider =
    !isSharing
    && useHostAgent
    && displayConfigureSupported === false
    && agentHealth.display?.provider !== "none"
  const startBlockedByMode =
    !isSharing
    && useHostAgent
    && agentHealth.display?.provider !== "none"
    && (targetMonitorFound === false || invalidDraftModeForDetectedList)
  const startBlockedReason =
    startBlockedByProvider
      ? (displayConfigureReason || "Provider sem suporte real para configuracao de resolucao/DPI.")
      : startBlockedByMode
        ? (saveApplyBlockReason || "Selected mode is not valid for the detected monitor.")
        : null
  const profileApplyInProgress = displayActionBusy === "apply-profile"
  const profileSaveInProgress = displayActionBusy === "save-profile"
  const modeAddInProgress = displayActionBusy === "add-mode"
  const modeRemoveInProgress = displayActionBusy === "remove-mode"
  const canManageModes = displayModeManageSupported !== false
  const stateBadgeClass =
    streamState === "streaming"
      ? "bg-primary/15 text-primary border border-primary/30 font-mono text-xs"
      : streamState === "degraded"
        ? "bg-amber-500/15 text-amber-600 border border-amber-500/30 font-mono text-xs"
        : streamState === "error"
        ? "bg-destructive/15 text-destructive border border-destructive/30 font-mono text-xs"
        : "font-mono text-xs"
  const healthBadgeClass = (health: LinkHealth) => (
    health === "good"
      ? "border-primary/30 text-primary"
      : health === "fair"
        ? "border-amber-500/30 text-amber-600"
        : health === "poor"
          ? "border-destructive/30 text-destructive"
          : "border-border text-muted-foreground"
  )

  if (advancedStream) {
    return (
      <AdvancedPanel
        streamType={advancedStream}
        stats={advancedStream === "controller" ? controllerStats : viewerStats}
        onBack={() => setAdvancedStream(null)}
        pc={advancedStream === "controller" ? controllerPCRef.current : viewerPCRef.current}
      />
    )
  }

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-background">
        {/* Header */}
        <header className="border-b border-border">
          <div className="flex items-center justify-between px-6 py-4">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <Monitor className="h-5 w-5 text-primary" />
                <h1 className="text-lg font-semibold text-foreground font-mono tracking-tight">
                  ScreenLink
                </h1>
              </div>
              <Separator orientation="vertical" className="h-6" />
              <Badge
                variant={streamState === "error" ? "destructive" : isSharing ? "default" : "secondary"}
                className={stateBadgeClass}
              >
                <Radio className={`h-3 w-3 mr-1 ${stateIsLive ? "animate-pulse" : ""}`} />
                {stateLabel}
              </Badge>
            </div>

            <div className="flex items-center gap-2">
              {isSharing && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={toggleLock}
                      className="gap-1.5"
                    >
                      {sessionData?.controlLocked ? (
                        <Lock className="h-3.5 w-3.5 text-destructive" />
                      ) : (
                        <Unlock className="h-3.5 w-3.5" />
                      )}
                      <span className="text-xs font-mono">
                        {sessionData?.controlLocked ? "Locked" : "Unlocked"}
                      </span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {sessionData?.controlLocked
                      ? "Input control is locked"
                      : "Click to lock input control"}
                  </TooltipContent>
                </Tooltip>
              )}

              <Button
                variant={isSharing ? "destructive" : "default"}
                size="sm"
                onClick={isSharing ? stopSharing : startSharing}
                disabled={isBusy || startBlockedByProvider || startBlockedByMode}
                className="gap-1.5 font-mono text-xs"
                title={startBlockedReason || undefined}
              >
                {streamState === "starting" ? (
                  <>
                    <Radio className="h-3.5 w-3.5 animate-pulse" />
                    Starting...
                  </>
                ) : streamState === "stopping" ? (
                  <>
                    <Radio className="h-3.5 w-3.5 animate-pulse" />
                    Stopping...
                  </>
                ) : isSharing ? (
                  <>
                    <Square className="h-3.5 w-3.5" />
                    Stop Sharing
                  </>
                ) : (
                  <>
                    <Play className="h-3.5 w-3.5" />
                    Start Sharing
                  </>
                )}
              </Button>
              {sessionAccessCode && (
                <Badge variant="outline" className="font-mono text-xs border-primary/30 text-primary">
                  SENHA: {sessionAccessCode}
                </Badge>
              )}
            </div>
          </div>
        </header>

        <main className="p-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Connection Panel */}
            <Card className="lg:row-span-2 border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm font-mono">
                  <Wifi className="h-4 w-4 text-primary" />
                  Connection
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {isSharing ? (
                  <>
                    {streamState !== "streaming" && (
                      <div className="rounded-md border border-border bg-secondary/30 px-3 py-2">
                        <p className="text-[11px] font-mono text-muted-foreground">
                          {streamState === "awaiting-clients"
                            ? "Negotiating connection with clients..."
                            : streamState === "degraded"
                              ? "Connection degraded. Reconnecting automatically..."
                              : "Streaming state transitioning..."}
                        </p>
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Users className="h-4 w-4" />
                        <span className="font-mono">
                          {clients.length}/2 connected
                        </span>
                      </div>
                      <div className="flex gap-1">
                        {[0, 1].map((i) => (
                          <div
                            key={i}
                            className={`h-2 w-2 rounded-full ${
                              i < clients.length
                                ? "bg-primary"
                                : "bg-muted"
                            }`}
                          />
                        ))}
                      </div>
                    </div>

                    <div className="rounded-lg bg-secondary/50 p-4 flex items-center justify-center">
                      <QRCodeSVG
                        value={joinUrl}
                        size={200}
                        bgColor="transparent"
                        fgColor="hsl(142, 71%, 72%)"
                        level="M"
                        includeMargin={false}
                      />
                    </div>

                    <div className="flex items-center gap-2">
                      <code className="flex-1 text-xs font-mono bg-secondary/50 rounded px-2 py-1.5 text-muted-foreground truncate">
                        {joinUrl}
                      </code>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 shrink-0"
                            onClick={copyUrl}
                          >
                            {copied ? (
                              <Check className="h-3.5 w-3.5 text-primary" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Copy join URL</TooltipContent>
                      </Tooltip>
                    </div>

                    <div className="grid grid-cols-1 gap-2 rounded-md border border-border bg-secondary/20 p-2.5">
                      <div className="flex items-center justify-between text-xs font-mono">
                        <span className="text-muted-foreground">Host</span>
                        <span className="text-foreground">{sessionHostLabel}</span>
                      </div>
                      <div className="flex items-center justify-between text-xs font-mono">
                        <span className="text-muted-foreground">Access code</span>
                        <span className="text-primary tracking-wider">{sessionAccessCode || "------"}</span>
                      </div>
                    </div>

                    <Separator />

                    {/* Connected clients list */}
                    <div className="flex flex-col gap-2">
                      <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                        Clients
                      </p>
                      {clients.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          Waiting for connections...
                        </p>
                      ) : (
                        clients.map((client: { id: string; role: string; connectedAt: number }) => (
                          <div
                            key={client.id}
                            className="flex items-center justify-between rounded-md bg-secondary/50 px-3 py-2"
                          >
                            <div className="flex items-center gap-2">
                              {client.role === "controller" ? (
                                <Gamepad2 className="h-3.5 w-3.5 text-primary" />
                              ) : (
                                <Eye className="h-3.5 w-3.5 text-accent" />
                              )}
                              <span className="text-xs font-mono">
                                {client.id.slice(0, 8)}
                              </span>
                            </div>
                            <Badge
                              variant="outline"
                              className={`text-[10px] font-mono ${
                                client.role === "controller"
                                  ? "border-primary/30 text-primary"
                                  : "border-accent/30 text-accent"
                              }`}
                            >
                              {client.role.toUpperCase()}
                            </Badge>
                          </div>
                        ))
                      )}
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col items-center gap-4 py-8">
                    <WifiOff className="h-12 w-12 text-muted-foreground/30" />
                    <div className="text-center">
                      <p className="text-sm text-muted-foreground">
                        {streamState === "starting"
                          ? "Starting sharing..."
                          : streamState === "stopping"
                            ? "Stopping sharing..."
                            : streamState === "error"
                              ? "Sharing error"
                              : "Not sharing"}
                      </p>
                      <p className="text-xs text-muted-foreground/60 mt-1">
                        {streamState === "error"
                          ? "Review permissions or browser support and try again."
                          : "Click Start Sharing to begin"}
                      </p>
                    </div>
                    {startError && (
                      <p className="text-xs text-destructive text-center max-w-[22rem]">
                        {startError}
                      </p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Controller Stream Card */}
            <StreamMetricsCard
              title="Controller Stream"
              subtitle="LIVE"
              icon={<Zap className="h-4 w-4" />}
              active={!!controllerClient}
              stats={controllerStats}
              accentClass="text-primary"
              onDrillDown={() => setAdvancedStream("controller")}
            />

            {/* Viewer Stream Card */}
            <StreamMetricsCard
              title="Viewer Stream"
              subtitle="QUALITY"
              icon={<Eye className="h-4 w-4" />}
              active={!!viewerClient}
              stats={viewerStats}
              accentClass="text-accent"
              onDrillDown={() => setAdvancedStream("viewer")}
            />

            {/* Session Info */}
            <Card className="lg:col-span-2 border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm font-mono">
                  <Activity className="h-4 w-4 text-primary" />
                  Session Info
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <InfoItem
                    label="Session ID"
                    value={sessionId ? sessionId.slice(0, 12) + "..." : "---"}
                  />
                  <InfoItem
                    label="Status"
                    value={stateLabel}
                    highlight={stateIsLive}
                  />
                  <InfoItem
                    label="Clients"
                    value={`${clients.length}/2`}
                  />
                  <InfoItem
                    label="Control"
                    value={sessionData?.controlLocked ? "Locked" : "Open"}
                  />
                </div>

                <div className="mt-4 flex flex-col gap-3">
                  {isSharing ? (
                    <div className="p-3 rounded-md bg-secondary/30 border border-border">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
                        <ArrowUpRight className="h-3 w-3" />
                        <span>
                          Scan the QR code or share the join URL with up to 2 devices on your local network.
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="p-3 rounded-md bg-secondary/30 border border-border">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
                        <ArrowUpRight className="h-3 w-3" />
                        <span>
                          Configure and prepare the second display now, then click Start Sharing.
                        </span>
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="rounded-md border border-border bg-secondary/20 p-3">
                        <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
                          Latency Profile
                        </p>
                        <div className="mt-2 flex items-center justify-between">
                          <span className="text-xs font-mono text-foreground">
                            {latencyProfile === "low-latency" ? "Low Latency LAN" : "Balanced Quality"}
                          </span>
                          <Switch
                            checked={latencyProfile === "low-latency"}
                            onCheckedChange={(checked) => {
                              setLatencyProfile(checked ? "low-latency" : "balanced")
                            }}
                          />
                        </div>
                        <div className="mt-3 flex items-center justify-between">
                          <span className="text-xs font-mono text-muted-foreground">
                            Auto Tune
                          </span>
                          <Switch checked={autoTune} onCheckedChange={setAutoTune} />
                        </div>
                        <div className="mt-3 flex items-center justify-between">
                          <span className="text-xs font-mono text-muted-foreground">
                            Host Agent
                          </span>
                          <Switch checked={useHostAgent} onCheckedChange={setUseHostAgent} />
                        </div>
                        <div className="mt-3 rounded-md border border-border/70 bg-background/30 p-2.5">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
                              Display Profile
                            </span>
                            <Badge
                              variant="outline"
                              className={`text-[10px] font-mono ${
                                displayProfileDirty
                                  ? "border-amber-500/30 text-amber-600"
                                  : "border-border text-muted-foreground"
                              }`}
                            >
                              {displayProfileDirty ? "DRAFT" : "SYNCED"}
                            </Badge>
                          </div>
                          <div className="mt-2 grid grid-cols-1 gap-2">
                            <Select
                              value={selectedModeDetected ? selectedModeKey : "__custom__"}
                              onValueChange={selectDetectedDisplayMode}
                              disabled={displayControlsDisabled || displayModeOptions.length === 0}
                            >
                              <SelectTrigger className="h-7 w-full text-[10px] font-mono text-foreground">
                                <SelectValue placeholder="No detected modes" aria-label={selectedModeLabel}>
                                  {selectedModeLabel}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectContent>
                                {displayModeOptions.length === 0 ? (
                                  <SelectItem value={selectedModeKey}>
                                    No detected modes (run Probe Provider)
                                  </SelectItem>
                                ) : (
                                  <>
                                    <SelectItem value="__custom__">
                                      Custom {displayProfile.width}x{displayProfile.height} @{displayProfile.refreshHz}Hz {displayProfile.colorDepth}bit
                                    </SelectItem>
                                    {displayModeOptions.map((mode) => (
                                      <SelectItem key={modeKey(mode)} value={modeKey(mode)}>
                                        {mode.width}x{mode.height} @{mode.hz}Hz {mode.bitDepth}bit{mode.current ? " (current)" : ""}
                                      </SelectItem>
                                    ))}
                                  </>
                                )}
                              </SelectContent>
                            </Select>
                            {targetMonitorFound === false && (
                              <p className="text-[10px] font-mono text-amber-600">
                                Target monitor {displayProfile.monitorId} not detected by provider.
                              </p>
                            )}
                            {invalidDraftModeForDetectedList && (
                              <p className="text-[10px] font-mono text-amber-600">
                                Current draft mode is not in detected list and provider cannot add custom modes.
                              </p>
                            )}
                            {modeMissingFromDetectedList && displayModeManageSupported !== false && (
                              <p className="text-[10px] font-mono text-muted-foreground">
                                Draft mode is not currently detected. Save + Apply will try Add Mode first.
                              </p>
                            )}
                          </div>
                          <div className="mt-2 grid grid-cols-2 gap-2">
                            <Input
                              type="number"
                              className="h-7 text-[10px] font-mono"
                              placeholder="Width"
                              min={effectiveDisplayCapabilities.width.min}
                              max={effectiveDisplayCapabilities.width.max}
                              value={displayProfile.width}
                              onChange={(event) => {
                                setDisplayProfileNumberField("width", event.target.value)
                              }}
                            />
                            <Input
                              type="number"
                              className="h-7 text-[10px] font-mono"
                              placeholder="Height"
                              min={effectiveDisplayCapabilities.height.min}
                              max={effectiveDisplayCapabilities.height.max}
                              value={displayProfile.height}
                              onChange={(event) => {
                                setDisplayProfileNumberField("height", event.target.value)
                              }}
                            />
                            <Input
                              type="number"
                              className="h-7 text-[10px] font-mono"
                              placeholder="Refresh Hz"
                              min={effectiveDisplayCapabilities.refreshHz.min}
                              max={effectiveDisplayCapabilities.refreshHz.max}
                              value={displayProfile.refreshHz}
                              onChange={(event) => {
                                setDisplayProfileNumberField("refreshHz", event.target.value)
                              }}
                            />
                            <Input
                              type="number"
                              className="h-7 text-[10px] font-mono"
                              placeholder="DPI"
                              min={effectiveDisplayCapabilities.dpi.min}
                              max={effectiveDisplayCapabilities.dpi.max}
                              value={displayProfile.dpi}
                              onChange={(event) => {
                                setDisplayProfileNumberField("dpi", event.target.value)
                              }}
                            />
                            <Input
                              type="number"
                              className="h-7 text-[10px] font-mono"
                              placeholder="Scale %"
                              min={effectiveDisplayCapabilities.scalePercent.min}
                              max={effectiveDisplayCapabilities.scalePercent.max}
                              value={displayProfile.scalePercent}
                              onChange={(event) => {
                                setDisplayProfileNumberField("scalePercent", event.target.value)
                              }}
                            />
                            <Input
                              type="number"
                              className="h-7 text-[10px] font-mono"
                              placeholder="Color Depth"
                              min={effectiveDisplayCapabilities.colorDepth.min}
                              max={effectiveDisplayCapabilities.colorDepth.max}
                              value={displayProfile.colorDepth}
                              onChange={(event) => {
                                setDisplayProfileNumberField("colorDepth", event.target.value)
                              }}
                            />
                            <Input
                              type="number"
                              className="h-7 text-[10px] font-mono"
                              placeholder="Monitor Id"
                              min={effectiveDisplayCapabilities.monitorId.min}
                              max={effectiveDisplayCapabilities.monitorId.max}
                              value={displayProfile.monitorId}
                              onChange={(event) => {
                                setDisplayProfileNumberField("monitorId", event.target.value)
                              }}
                            />
                          </div>
                          <div className="mt-2 flex items-center gap-2">
                            <Button
                              variant={displayProfile.orientation === "landscape" ? "secondary" : "ghost"}
                              size="sm"
                              className="h-7 text-[10px] font-mono"
                              onClick={() => {
                                updateDisplayDraft({ orientation: "landscape" })
                              }}
                              disabled={displayControlsDisabled}
                            >
                              Landscape
                            </Button>
                            <Button
                              variant={displayProfile.orientation === "portrait" ? "secondary" : "ghost"}
                              size="sm"
                              className="h-7 text-[10px] font-mono"
                              onClick={() => {
                                updateDisplayDraft({ orientation: "portrait" })
                              }}
                              disabled={displayControlsDisabled}
                            >
                              Portrait
                            </Button>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-[10px] font-mono"
                              onClick={() => {
                                void saveDisplayProfile(false)
                              }}
                              disabled={displayControlsDisabled}
                            >
                              {profileSaveInProgress ? "Saving..." : "Save Profile"}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-[10px] font-mono"
                              onClick={() => {
                                void saveDisplayProfile(true)
                              }}
                              disabled={saveApplyDisabled}
                            >
                              {profileApplyInProgress ? "Applying..." : "Save + Apply"}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-[10px] font-mono"
                              onClick={() => {
                                void addDisplayMode()
                              }}
                              disabled={displayControlsDisabled || !canManageModes}
                            >
                              {modeAddInProgress ? "Adding..." : "Add Mode"}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-[10px] font-mono"
                              onClick={() => {
                                void removeDisplayMode()
                              }}
                              disabled={displayControlsDisabled || !canManageModes}
                            >
                              {modeRemoveInProgress ? "Removing..." : "Remove Mode"}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-[10px] font-mono"
                              onClick={() => {
                                void refreshDisplayProfile()
                              }}
                              disabled={displayControlsDisabled}
                            >
                              Reload Profile
                            </Button>
                          </div>
                          <p className="mt-2 text-[10px] font-mono text-muted-foreground">
                            Applied before virtualization when provider supports configure command.
                          </p>
                          {displayConfigureSupported === false && (
                            <p className="mt-1 text-[10px] font-mono text-amber-600">
                              {displayConfigureReason || "Current provider does not apply resolution/DPI values."}
                            </p>
                          )}
                          {displayConfigureSupported !== false && saveApplyBlockReason && (
                            <p className="mt-1 text-[10px] font-mono text-amber-600">
                              {saveApplyBlockReason}
                            </p>
                          )}
                          {displayModeManageSupported === false && (
                            <p className="mt-1 text-[10px] font-mono text-amber-600">
                              {displayModeManageReason || "Current provider does not support ADD/REMOVE mode commands."}
                            </p>
                          )}
                          <div className="mt-2 rounded-md border border-border/70 bg-background/20 p-2.5">
                            <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
                              Provider Info & Limits
                            </p>
                            <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-[10px] font-mono">
                              <span className="text-muted-foreground">Provider</span>
                              <span className="text-foreground">{providerName}</span>
                              <span className="text-muted-foreground">Configure</span>
                              <span className={displayConfigureSupported === false ? "text-amber-600" : "text-foreground"}>
                                {providerConfigureLabel}
                              </span>
                              <span className="text-muted-foreground">Display mode</span>
                              <span className="text-foreground">{providerMode}</span>
                              <span className="text-muted-foreground">Mode add/remove</span>
                              <span className={displayModeManageSupported === false ? "text-amber-600" : "text-foreground"}>
                                {providerModeManageLabel}
                              </span>
                              <span className="text-muted-foreground">Target monitor</span>
                              <span className="text-foreground">{displayProfile.monitorId}</span>
                              <span className="text-muted-foreground">Detected monitors</span>
                              <span className={targetMonitorFound === false ? "text-amber-600" : "text-foreground"}>
                                {detectedMonitorIds.length ? detectedMonitorIds.join(", ") : "--"}
                              </span>
                              <span className="text-muted-foreground">Detected modes</span>
                              <span className="text-foreground">{displayModeOptions.length}</span>
                              <span className="text-muted-foreground">Width</span>
                              <span className="text-foreground">
                                {effectiveDisplayCapabilities.width.min}-{effectiveDisplayCapabilities.width.max}
                              </span>
                              <span className="text-muted-foreground">Height</span>
                              <span className="text-foreground">
                                {effectiveDisplayCapabilities.height.min}-{effectiveDisplayCapabilities.height.max}
                              </span>
                              <span className="text-muted-foreground">Refresh (Hz)</span>
                              <span className="text-foreground">
                                {effectiveDisplayCapabilities.refreshHz.min}-{effectiveDisplayCapabilities.refreshHz.max}
                              </span>
                              <span className="text-muted-foreground">DPI</span>
                              <span className="text-foreground">
                                {effectiveDisplayCapabilities.dpi.min}-{effectiveDisplayCapabilities.dpi.max}
                              </span>
                              <span className="text-muted-foreground">Scale (%)</span>
                              <span className="text-foreground">
                                {effectiveDisplayCapabilities.scalePercent.min}-{effectiveDisplayCapabilities.scalePercent.max}
                              </span>
                              <span className="text-muted-foreground">Color depth</span>
                              <span className="text-foreground">
                                {effectiveDisplayCapabilities.colorDepth.min}-{effectiveDisplayCapabilities.colorDepth.max} bits
                              </span>
                              <span className="text-muted-foreground">Monitor Id</span>
                              <span className="text-foreground">
                                {effectiveDisplayCapabilities.monitorId.min}-{effectiveDisplayCapabilities.monitorId.max}
                              </span>
                              <span className="text-muted-foreground">Orientation</span>
                              <span className="text-foreground">
                                {effectiveDisplayCapabilities.orientation.join(" / ")}
                              </span>
                            </div>
                            {(displayConfigureReason || displayModeManageReason) && (
                              <p className="mt-2 text-[10px] font-mono text-muted-foreground break-words">
                                Reason: {[displayConfigureReason, displayModeManageReason].filter(Boolean).join(" | ")}
                              </p>
                            )}
                          </div>
                        </div>
                        <p className="mt-2 text-[10px] font-mono text-muted-foreground">
                          Agent endpoint: 127.0.0.1:47831 ({agentStatus}) | Stream: {agentStreamConnected ? "live" : "polling"}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-[10px] font-mono"
                            onClick={() => {
                              void ensureDisplay()
                            }}
                            disabled={displayControlsDisabled}
                          >
                            {displayActionBusy === "ensure" ? "Expanding..." : "Expand Display"}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-[10px] font-mono"
                            onClick={() => {
                              void releaseDisplay()
                            }}
                            disabled={displayControlsDisabled}
                          >
                            {displayActionBusy === "release" ? "Reverting..." : "Revert Display"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-[10px] font-mono"
                            onClick={() => {
                              void refreshDisplay()
                            }}
                            disabled={displayControlsDisabled}
                          >
                            {displayActionBusy === "refresh" ? "Refreshing..." : "Refresh Display"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-[10px] font-mono"
                            onClick={() => {
                              void probeDisplay()
                            }}
                            disabled={displayControlsDisabled}
                          >
                            {displayActionBusy === "probe" ? "Probing..." : "Probe Provider"}
                          </Button>
                        </div>
                      </div>

                      <div className="rounded-md border border-border bg-secondary/20 p-3">
                        <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
                          Link Health
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Badge variant="outline" className={`text-[10px] font-mono ${healthBadgeClass(linkHealth.controller)}`}>
                            CTRL {LINK_HEALTH_LABEL[linkHealth.controller]}
                          </Badge>
                          <Badge variant="outline" className={`text-[10px] font-mono ${healthBadgeClass(linkHealth.viewer)}`}>
                            VIEW {LINK_HEALTH_LABEL[linkHealth.viewer]}
                          </Badge>
                          <Badge variant="outline" className="text-[10px] font-mono border-border text-muted-foreground">
                            AUTO {autoTune ? "ON" : "OFF"}
                          </Badge>
                          <Badge
                            variant="outline"
                            className={`text-[10px] font-mono ${
                              agentStatus === "available"
                                ? "border-primary/30 text-primary"
                                : agentStatus === "checking"
                                  ? "border-amber-500/30 text-amber-600"
                                  : "border-destructive/30 text-destructive"
                            }`}
                          >
                            AGENT {agentStatus.toUpperCase()}
                          </Badge>
                          <Badge
                            variant="outline"
                            className={`text-[10px] font-mono ${
                              agentStreamConnected
                                ? "border-primary/30 text-primary"
                                : "border-border text-muted-foreground"
                            }`}
                          >
                            SSE {agentStreamConnected ? "LIVE" : "OFF"}
                          </Badge>
                        </div>
                        <p className="mt-2 text-[10px] font-mono text-muted-foreground">
                          Controller state: {peerStatus.controller} | Viewer state: {peerStatus.viewer}
                        </p>
                        {agentHealth.version && (
                          <p className="mt-1 text-[10px] font-mono text-muted-foreground">
                            Version: {agentHealth.version} | Capture: {agentHealth.captureMode}
                          </p>
                        )}
                        {agentHealth.display && (
                          <p className="mt-1 text-[10px] font-mono text-muted-foreground">
                            Display: {agentHealth.display.provider || "unknown"} | {agentHealth.display.active ? "active" : "inactive"}
                            {agentHealth.display.mode ? ` | mode: ${agentHealth.display.mode}` : ""}
                            {agentHealth.display.profile
                              ? ` | profile: m${agentHealth.display.profile.monitorId} ${agentHealth.display.profile.width}x${agentHealth.display.profile.height}@${agentHealth.display.profile.refreshHz}Hz ${agentHealth.display.profile.scalePercent}% ${agentHealth.display.profile.orientation}`
                              : ""}
                            {agentHealth.display.lastActionAt ? ` | last action: ${new Date(agentHealth.display.lastActionAt).toLocaleTimeString()}` : ""}
                            {agentHealth.display.lastError ? ` | error: ${agentHealth.display.lastError}` : ""}
                          </p>
                        )}
                        {agentHealth.display?.lastOutput && (
                          <p className="mt-1 text-[10px] font-mono text-muted-foreground break-all">
                            Output: {agentHealth.display.lastOutput}
                          </p>
                        )}
                        {(agentLastEventAt || agentMemoryMb !== null) && (
                          <p className="mt-1 text-[10px] font-mono text-muted-foreground">
                            {agentLastEventAt
                              ? `Last event: ${new Date(agentLastEventAt).toLocaleTimeString()}`
                              : "Last event: --"}
                            {agentMemoryMb !== null ? ` | Agent RSS: ${agentMemoryMb.toFixed(1)} MB` : ""}
                          </p>
                        )}
                      </div>
                    </div>
                  {agentMessage && (
                    <p className="text-[10px] font-mono text-muted-foreground">
                      {agentMessage}
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </main>
      </div>
    </TooltipProvider>
  )
}

function InfoItem({
  label,
  value,
  highlight,
}: {
  label: string
  value: string
  highlight?: boolean
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
        {label}
      </span>
      <span
        className={`text-sm font-mono ${
          highlight ? "text-primary" : "text-foreground"
        }`}
      >
        {value}
      </span>
    </div>
  )
}

function parseStats(statsReport: RTCStatsReport, timestamp: number): StreamStats | null {
  let resolution = "---"
  let fps = 0
  let bitrate = 0
  let rtt = 0
  let packetLoss = 0
  let jitter = 0

  statsReport.forEach((report) => {
    if (report.type === "outbound-rtp" && report.kind === "video") {
      if (report.frameWidth && report.frameHeight) {
        resolution = `${report.frameWidth}x${report.frameHeight}`
      }
      fps = report.framesPerSecond || 0
      bitrate = (report.bytesSent || 0) * 8
    }
    if (report.type === "remote-inbound-rtp" && report.kind === "video") {
      rtt = (report.roundTripTime || 0) * 1000
      jitter = (report.jitter || 0) * 1000
      packetLoss = normalizePacketLoss(report.fractionLost || 0)
    }
  })

  return {
    resolution,
    fps,
    bitrate,
    rtt,
    packetLoss,
    jitter,
    cpuUsage: 0,
    gpuUsage: 0,
    timestamp,
  }
}

function normalizePacketLoss(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value <= 1) return value
  if (value <= 255) return value / 255
  return 1
}
