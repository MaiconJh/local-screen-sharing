"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { useSearchParams } from "next/navigation"
import {
  Monitor,
  Gamepad2,
  Eye,
  Wifi,
  WifiOff,
  LogOut,
  Activity,
  Gauge,
  Clock,
  Signal,
  Waves,
  Maximize2,
  Minimize2,
  Settings2,
  Radio,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Card, CardContent } from "@/components/ui/card"
import type { ClientRole, StreamStats, InputEvent } from "@/lib/types"

type ClientState = "connecting" | "connected" | "error" | "ended" | "full"

export function ClientApp() {
  const searchParams = useSearchParams()
  const token = searchParams.get("token")
  const qrCodeAccessCode = searchParams.get("code")

  const [clientId] = useState(() => Math.random().toString(36).substring(2, 10) + Date.now().toString(36))
  const [state, setState] = useState<ClientState>("connecting")
  const [role, setRole] = useState<ClientRole | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [hostLabel, setHostLabel] = useState<string>("Host")
  const [hostSignalTarget, setHostSignalTarget] = useState<string | null>(null)
  const [accessCode, setAccessCode] = useState("")
  const [authReady, setAuthReady] = useState(false)
  const [isJoining, setIsJoining] = useState(false)
  const [errorMsg, setErrorMsg] = useState("")
  const attemptedQrAutoJoinRef = useRef(false)

  const [showStats, setShowStats] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [enhancedMode, setEnhancedMode] = useState(false)
  const [bufferMs, setBufferMs] = useState(500)
  const [showSettings, setShowSettings] = useState(false)
  const [hasRemoteStream, setHasRemoteStream] = useState(false)
  const [playbackBlocked, setPlaybackBlocked] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const dataChannelRef = useRef<RTCDataChannel | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pendingRemoteCandidatesRef = useRef<RTCIceCandidateInit[]>([])

  const [stats, setStats] = useState<StreamStats | null>(null)

  const tryPlayVideo = useCallback(async () => {
    const video = videoRef.current
    if (!video) return
    try {
      await video.play()
      setPlaybackBlocked(false)
    } catch {
      setPlaybackBlocked(true)
    }
  }, [])

  useEffect(() => {
    if (!token) {
      setState("error")
      setErrorMsg("No access token provided")
      return
    }

    const preview = async () => {
      try {
        const res = await fetch("/api/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "preview", token }),
        })
        const data = await res.json()
        if (!data.success) {
          setState("ended")
          setErrorMsg(data.error || "Session ended")
          return
        }
        setHostLabel(data.hostLabel || "Host")
        setAuthReady(true)
      } catch {
        setState("error")
        setErrorMsg("Failed to load host information")
      }
    }

    preview()
  }, [token])

  useEffect(() => {
    if (!qrCodeAccessCode) return
    setAccessCode(String(qrCodeAccessCode).replace(/\D+/g, "").slice(0, 6))
  }, [qrCodeAccessCode])

  const sendViewerCapabilities = useCallback(async () => {
    if (!sessionId || !hostSignalTarget) return
    const payload = {
      width: window.screen.width,
      height: window.screen.height,
      availWidth: window.screen.availWidth,
      availHeight: window.screen.availHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    }
    await fetch("/api/signal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "viewer-capabilities",
        from: clientId,
        to: hostSignalTarget,
        sessionId,
        payload,
      }),
    })
  }, [clientId, hostSignalTarget, sessionId])

  // Join session cleanup
  useEffect(() => {
    return () => {
      eventSourceRef.current?.close()
      pcRef.current?.close()
      if (statsIntervalRef.current) clearInterval(statsIntervalRef.current)
      pendingRemoteCandidatesRef.current = []
      setHasRemoteStream(false)
      setPlaybackBlocked(false)
    }
  }, [])

  const handleHostSignal = useCallback(
    async (signal: { type: string; from: string; payload: unknown }) => {
      if (signal.type === "offer") {
        pcRef.current?.close()
        pendingRemoteCandidatesRef.current = []

        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        })
        pcRef.current = pc

        pc.ontrack = (event) => {
          if (videoRef.current && event.streams[0]) {
            videoRef.current.srcObject = event.streams[0]
            setHasRemoteStream(true)
            void tryPlayVideo()
          }
        }

        pc.ondatachannel = (event) => {
          dataChannelRef.current = event.channel
        }

        pc.onicecandidate = (event) => {
          if (event.candidate) {
            fetch("/api/signal", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                type: "ice-candidate",
                from: clientId,
                to: signal.from,
                sessionId,
                payload: event.candidate.toJSON(),
              }),
            })
          }
        }

        await pc.setRemoteDescription(
          new RTCSessionDescription(signal.payload as RTCSessionDescriptionInit)
        )

        // Flush remote ICE candidates that arrived before the offer/description was ready.
        for (const candidate of pendingRemoteCandidatesRef.current) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate))
          } catch {
            // ignore invalid/late candidates
          }
        }
        pendingRemoteCandidatesRef.current = []

        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)

        await fetch("/api/signal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "answer",
            from: clientId,
            to: signal.from,
            sessionId,
            payload: answer,
          }),
        })

        await sendViewerCapabilities()

        // Start stats collection
        statsIntervalRef.current = setInterval(async () => {
          try {
            const report = await pc.getStats()
            let resolution = "---"
            let fps = 0
            let bitrate = 0
            let rtt = 0
            let packetLoss = 0
            let jitter = 0

            report.forEach((r) => {
              if (r.type === "inbound-rtp" && r.kind === "video") {
                if (r.frameWidth && r.frameHeight) {
                  resolution = `${r.frameWidth}x${r.frameHeight}`
                }
                fps = r.framesPerSecond || 0
                bitrate = (r.bytesReceived || 0) * 8
              }
              if (r.type === "remote-outbound-rtp" || r.type === "candidate-pair") {
                if (r.currentRoundTripTime) {
                  rtt = r.currentRoundTripTime * 1000
                }
              }
            })

            setStats({
              resolution,
              fps,
              bitrate,
              rtt,
              packetLoss,
              jitter,
              cpuUsage: 0,
              gpuUsage: 0,
              timestamp: Date.now(),
            })
          } catch { /* closed */ }
        }, 1000)
      } else if (signal.type === "ice-candidate") {
        const candidate = signal.payload as RTCIceCandidateInit
        const pc = pcRef.current
        if (!pc || !pc.remoteDescription) {
          pendingRemoteCandidatesRef.current.push(candidate)
          return
        }
        await pc.addIceCandidate(new RTCIceCandidate(candidate))
      }
    },
    [clientId, sendViewerCapabilities, sessionId, tryPlayVideo]
  )

  const joinSessionWithCode = useCallback(async (code: string) => {
    if (!token) return
    setIsJoining(true)
    setErrorMsg("")
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "join", token, accessCode: code.trim(), clientId }),
      })
      const data = await res.json()

      if (!data.success) {
        if (data.error === "Host full") {
          setState("full")
        } else if (data.error === "Invalid access code") {
          setState("connecting")
        } else {
          setState("ended")
        }
        setErrorMsg(data.error || "Unable to join")
        return
      }

      setRole(data.role)
      setSessionId(data.sessionId)
      setHostSignalTarget(`host-${data.hostId}`)
      setHostLabel(data.hostLabel || hostLabel)
      setState("connected")

      const evtSource = new EventSource(`/api/signal?listenerId=${clientId}`)
      eventSourceRef.current = evtSource

      evtSource.onmessage = async (event) => {
        const signal = JSON.parse(event.data)
        if (signal.type === "connected") return
        await handleHostSignal(signal)
      }

      await fetch("/api/signal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "viewer-capabilities",
          from: clientId,
          to: `host-${data.hostId}`,
          sessionId: data.sessionId,
          payload: {
            width: window.screen.width,
            height: window.screen.height,
            availWidth: window.screen.availWidth,
            availHeight: window.screen.availHeight,
            devicePixelRatio: window.devicePixelRatio || 1,
          },
        }),
      })
    } catch {
      setState("error")
      setErrorMsg("Failed to connect to host")
    } finally {
      setIsJoining(false)
    }
  }, [clientId, handleHostSignal, hostLabel, token])

  const joinSession = useCallback(async () => {
    await joinSessionWithCode(accessCode)
  }, [accessCode, joinSessionWithCode])


  useEffect(() => {
    if (!authReady || !qrCodeAccessCode || attemptedQrAutoJoinRef.current) return
    const normalized = String(qrCodeAccessCode).replace(/\D+/g, "").slice(0, 6)
    if (normalized.length < 4) return
    attemptedQrAutoJoinRef.current = true
    setAccessCode(normalized)
    void joinSessionWithCode(normalized)
  }, [authReady, joinSessionWithCode, qrCodeAccessCode])

  // Input forwarding for controller
  const sendInput = useCallback(
    (event: InputEvent) => {
      if (role !== "controller" || !dataChannelRef.current) return
      if (dataChannelRef.current.readyState === "open") {
        dataChannelRef.current.send(JSON.stringify(event))
      }
    },
    [role]
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (role !== "controller" || !videoRef.current) return
      const rect = videoRef.current.getBoundingClientRect()
      sendInput({
        type: "mousemove",
        x: (e.clientX - rect.left) / rect.width,
        y: (e.clientY - rect.top) / rect.height,
        modifiers: {
          ctrl: e.ctrlKey,
          shift: e.shiftKey,
          alt: e.altKey,
          meta: e.metaKey,
        },
        timestamp: Date.now(),
      })
    },
    [role, sendInput]
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (role !== "controller" || !videoRef.current) return
      const rect = videoRef.current.getBoundingClientRect()
      sendInput({
        type: "mousedown",
        x: (e.clientX - rect.left) / rect.width,
        y: (e.clientY - rect.top) / rect.height,
        button: e.button,
        modifiers: {
          ctrl: e.ctrlKey,
          shift: e.shiftKey,
          alt: e.altKey,
          meta: e.metaKey,
        },
        timestamp: Date.now(),
      })
    },
    [role, sendInput]
  )

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (role !== "controller") return
      sendInput({
        type: "mouseup",
        button: e.button,
        modifiers: {
          ctrl: e.ctrlKey,
          shift: e.shiftKey,
          alt: e.altKey,
          meta: e.metaKey,
        },
        timestamp: Date.now(),
      })
    },
    [role, sendInput]
  )

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (role !== "controller") return
      sendInput({
        type: "wheel",
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        timestamp: Date.now(),
      })
    },
    [role, sendInput]
  )

  // Keyboard events
  useEffect(() => {
    if (role !== "controller") return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      e.preventDefault()
      sendInput({
        type: "keydown",
        key: e.key,
        code: e.code,
        modifiers: {
          ctrl: e.ctrlKey,
          shift: e.shiftKey,
          alt: e.altKey,
          meta: e.metaKey,
        },
        timestamp: Date.now(),
      })
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      e.preventDefault()
      sendInput({
        type: "keyup",
        key: e.key,
        code: e.code,
        modifiers: {
          ctrl: e.ctrlKey,
          shift: e.shiftKey,
          alt: e.altKey,
          meta: e.metaKey,
        },
        timestamp: Date.now(),
      })
    }

    window.addEventListener("keydown", handleKeyDown)
    window.addEventListener("keyup", handleKeyUp)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
      window.removeEventListener("keyup", handleKeyUp)
    }
  }, [role, sendInput])

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen()
      setIsFullscreen(true)
    } else {
      document.exitFullscreen()
      setIsFullscreen(false)
    }
  }, [])

  const disconnect = useCallback(async () => {
    pcRef.current?.close()
    eventSourceRef.current?.close()
    if (statsIntervalRef.current) clearInterval(statsIntervalRef.current)

    await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "leave", clientId }),
    })

    setState("ended")
  }, [clientId])

  // Error / not connected states
  if (state === "connecting") {
    if (authReady) {
      return (
        <div className="min-h-screen bg-background flex items-center justify-center p-4">
          <Card className="w-full max-w-md border-border bg-card">
            <CardContent className="pt-6 space-y-4">
              <div className="space-y-1">
                <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Conectando a</p>
                <h1 className="text-lg font-mono text-foreground">{hostLabel}</h1>
                <p className="text-sm text-muted-foreground">Digite a senha da transmissão para entrar.</p>
              </div>
              <Input
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="Senha (6 dígitos)"
                value={accessCode}
                onChange={(event) => {
                  setAccessCode(event.target.value.replace(/\D+/g, "").slice(0, 6))
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && accessCode.trim().length >= 4 && !isJoining) {
                    void joinSession()
                  }
                }}
              />
              {errorMsg && <p className="text-xs text-destructive font-mono">{errorMsg}</p>}
              <Button
                className="w-full font-mono"
                disabled={isJoining || accessCode.trim().length < 4}
                onClick={() => {
                  void joinSession()
                }}
              >
                {isJoining ? "Conectando..." : "Conectar"}
              </Button>
            </CardContent>
          </Card>
        </div>
      )
    }
    return <StatusScreen icon={<Wifi className="h-8 w-8 animate-pulse" />} title="Connecting..." subtitle="Joining the host session" />
  }

  if (state === "full") {
    return <StatusScreen icon={<WifiOff className="h-8 w-8" />} title="Host Full" subtitle="The maximum number of clients (2) are already connected." error />
  }

  if (state === "ended") {
    return <StatusScreen icon={<Monitor className="h-8 w-8" />} title="Session Ended" subtitle="The sharing session has ended or you have disconnected." />
  }

  if (state === "error") {
    return <StatusScreen icon={<WifiOff className="h-8 w-8" />} title="Connection Error" subtitle={errorMsg} error />
  }

  // Connected view
  return (
    <div ref={containerRef} className="min-h-screen bg-background flex flex-col">
      {/* Compact header */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-border bg-card/80 backdrop-blur-sm z-10">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Monitor className="h-4 w-4 text-primary" />
            <span className="text-sm font-mono font-medium text-foreground">ScreenLink</span>
          </div>
          <Separator orientation="vertical" className="h-4" />
          <Badge
            variant="outline"
            className={`text-[10px] font-mono ${
              role === "controller"
                ? "border-primary/30 text-primary"
                : "border-accent/30 text-accent"
            }`}
          >
            {role === "controller" ? (
              <><Gamepad2 className="h-3 w-3 mr-1" /> CONTROLLER</>
            ) : (
              <><Eye className="h-3 w-3 mr-1" /> VIEWER</>
            )}
          </Badge>
          <Badge variant="outline" className="text-[10px] font-mono border-primary/20 text-primary">
            <Radio className="h-2.5 w-2.5 mr-1 animate-pulse" />
            {role === "controller" ? "LIVE" : "QUALITY"}
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          {/* Stats toggle */}
          <Button
            variant={showStats ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setShowStats(!showStats)}
            className="gap-1.5 h-7 text-xs font-mono"
          >
            <Activity className="h-3 w-3" />
            Stats
          </Button>

          {/* Viewer-only settings */}
          {role === "viewer" && (
            <Button
              variant={showSettings ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setShowSettings(!showSettings)}
              className="gap-1.5 h-7 text-xs font-mono"
            >
              <Settings2 className="h-3 w-3" />
              Settings
            </Button>
          )}

          {/* Fullscreen */}
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleFullscreen}
            className="h-7 w-7"
          >
            {isFullscreen ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </Button>

          {/* Disconnect */}
          <Button
            variant="destructive"
            size="sm"
            onClick={disconnect}
            className="gap-1.5 h-7 text-xs font-mono"
          >
            <LogOut className="h-3 w-3" />
            Disconnect
          </Button>
        </div>
      </header>

      {/* Viewer settings bar */}
      {role === "viewer" && showSettings && (
        <div className="flex items-center gap-6 px-4 py-2 border-b border-border bg-card/50 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono text-muted-foreground">Playback:</span>
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-muted-foreground">Live</span>
              <Switch
                checked={enhancedMode}
                onCheckedChange={setEnhancedMode}
              />
              <span className="text-xs font-mono text-muted-foreground">Enhanced</span>
            </div>
          </div>

          {enhancedMode && (
            <div className="flex items-center gap-3 flex-1 max-w-xs">
              <span className="text-xs font-mono text-muted-foreground whitespace-nowrap">
                Buffer: {bufferMs}ms
              </span>
              <Slider
                value={[bufferMs]}
                onValueChange={([v]) => setBufferMs(v)}
                min={250}
                max={2000}
                step={50}
                className="flex-1"
              />
            </div>
          )}
        </div>
      )}

      {/* Video area */}
      <div className="flex-1 relative bg-secondary/20">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`absolute inset-0 w-full h-full object-contain ${
            role === "controller" ? "cursor-none" : ""
          }`}
          onLoadedMetadata={() => {
            void tryPlayVideo()
          }}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onWheel={handleWheel}
          onContextMenu={(e) => e.preventDefault()}
        />

        {/* Waiting for stream overlay */}
        {!hasRemoteStream && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex flex-col items-center gap-3 text-muted-foreground/40">
              <Monitor className="h-16 w-16" />
              <span className="text-sm font-mono">Waiting for stream...</span>
            </div>
          </div>
        )}

        {/* Mobile autoplay fallback */}
        {hasRemoteStream && playbackBlocked && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/30 backdrop-blur-sm">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void tryPlayVideo()
              }}
              className="font-mono"
            >
              Tap to start video
            </Button>
          </div>
        )}

        {/* Stats overlay */}
        {showStats && stats && (
          <div className="absolute top-3 left-3 rounded-lg bg-card/80 backdrop-blur-sm border border-border p-3 min-w-48">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
                <Activity className="h-3 w-3" />
                Stream Stats
              </div>
              <Separator />
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                <StatLine icon={<Gauge className="h-3 w-3" />} label="Res" value={stats.resolution} />
                <StatLine icon={<Signal className="h-3 w-3" />} label="FPS" value={`${stats.fps}`} />
                <StatLine
                  icon={<Waves className="h-3 w-3" />}
                  label="Bitrate"
                  value={`${(stats.bitrate / 1_000_000).toFixed(1)}M`}
                />
                <StatLine icon={<Clock className="h-3 w-3" />} label="RTT" value={`${stats.rtt.toFixed(0)}ms`} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function StatusScreen({
  icon,
  title,
  subtitle,
  error,
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
  error?: boolean
}) {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <Card className="border-border bg-card max-w-sm w-full mx-4">
        <CardContent className="flex flex-col items-center gap-4 py-10">
          <div className={error ? "text-destructive" : "text-muted-foreground"}>
            {icon}
          </div>
          <div className="text-center">
            <h1 className="text-lg font-mono font-semibold text-foreground">{title}</h1>
            <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function StatLine({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-[10px] font-mono text-muted-foreground">{label}:</span>
      <span className="text-[10px] font-mono text-foreground font-medium">{value}</span>
    </div>
  )
}
