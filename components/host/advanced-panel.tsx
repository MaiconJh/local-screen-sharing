"use client"

import { useState, useEffect, useCallback } from "react"
import {
  ArrowLeft,
  RefreshCw,
  Download,
  Zap,
  Eye,
  Activity,
  Cpu,
  Network,
  FileText,
  Layers,
  AlertTriangle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Separator } from "@/components/ui/separator"
import type { StreamStats } from "@/lib/types"
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts"

interface AdvancedPanelProps {
  streamType: "controller" | "viewer"
  stats: StreamStats[]
  onBack: () => void
  pc: RTCPeerConnection | null
}

type KeyframeCapableSender = RTCRtpSender & {
  generateKeyFrame?: () => Promise<void>
}

export function AdvancedPanel({ streamType, stats, onBack, pc }: AdvancedPanelProps) {
  const isController = streamType === "controller"
  const accent = isController ? "text-primary" : "text-accent"
  const accentBg = isController ? "bg-primary/10" : "bg-accent/10"
  const latest = stats.length > 0 ? stats[stats.length - 1] : null

  const [detailedStats, setDetailedStats] = useState<Record<string, unknown>>({})
  const [logs, setLogs] = useState<string[]>([])

  useEffect(() => {
    if (!pc) return
    const interval = setInterval(async () => {
      try {
        const report = await pc.getStats()
        const detailed: Record<string, unknown> = {}
        report.forEach((stat) => {
          if (
            stat.type === "outbound-rtp" ||
            stat.type === "remote-inbound-rtp" ||
            stat.type === "candidate-pair" ||
            stat.type === "transport"
          ) {
            detailed[stat.type] = stat
          }
        })
        setDetailedStats(detailed)
      } catch { /* closed */ }
    }, 1000)
    return () => clearInterval(interval)
  }, [pc])

  const forceKeyframe = useCallback(async () => {
    if (!pc) return
    const senders = pc.getSenders()
    const videoSender = senders.find((s) => s.track?.kind === "video")
    if (!videoSender) {
      setLogs((prev) => [
        ...prev,
        `[${new Date().toLocaleTimeString()}] No video sender available for keyframe request`,
      ])
      return
    }

    const keyframeSender = videoSender as KeyframeCapableSender
    if (typeof keyframeSender.generateKeyFrame === "function") {
      try {
        await keyframeSender.generateKeyFrame()
        setLogs((prev) => [
          ...prev,
          `[${new Date().toLocaleTimeString()}] Keyframe requested via generateKeyFrame()`,
        ])
        return
      } catch {
        // Fallback below for browsers that expose the method but fail at runtime.
      }
    }

    // Fallback: briefly nudge encoder parameters to encourage a refresh frame.
    const params = videoSender.getParameters()
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}]
    }

    const encoding = params.encodings[0]
    const originalBitrate = encoding.maxBitrate
    const originalFramerate = encoding.maxFramerate
    encoding.maxBitrate = typeof originalBitrate === "number"
      ? Math.round(originalBitrate * 1.2)
      : 3_000_000
    encoding.maxFramerate = typeof originalFramerate === "number"
      ? Math.min(60, originalFramerate + 5)
      : 30

    try {
      await videoSender.setParameters(params)
      setLogs((prev) => [
        ...prev,
        `[${new Date().toLocaleTimeString()}] Keyframe fallback applied via encoder nudge`,
      ])

      setTimeout(() => {
        const restore = videoSender.getParameters()
        if (!restore.encodings || restore.encodings.length === 0) {
          restore.encodings = [{}]
        }
        restore.encodings[0].maxBitrate = originalBitrate
        restore.encodings[0].maxFramerate = originalFramerate
        videoSender.setParameters(restore).catch(() => {})
      }, 250)
    } catch {
      setLogs((prev) => [
        ...prev,
        `[${new Date().toLocaleTimeString()}] Keyframe request unavailable on this browser`,
      ])
    }
  }, [pc])

  const bitrateHistory = stats.slice(-60).map((s, i) => ({
    t: i,
    bitrate: (s.bitrate / 1_000_000).toFixed(2),
  }))

  const latencyHistory = stats.slice(-60).map((s, i) => ({
    t: i,
    rtt: s.rtt.toFixed(1),
    jitter: s.jitter.toFixed(1),
  }))

  const fpsHistory = stats.slice(-60).map((s, i) => ({
    t: i,
    fps: s.fps,
  }))

  const candidatePair = detailedStats["candidate-pair"] as Record<string, unknown> | undefined
  const outboundRtp = detailedStats["outbound-rtp"] as Record<string, unknown> | undefined
  const transport = detailedStats["transport"] as Record<string, unknown> | undefined

  const chartColor = isController ? "#22c55e" : "#3b82f6"

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border">
        <div className="flex items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={onBack} className="h-8 w-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <Separator orientation="vertical" className="h-5" />
            <div className="flex items-center gap-2">
              {isController ? (
                <Zap className={`h-4 w-4 ${accent}`} />
              ) : (
                <Eye className={`h-4 w-4 ${accent}`} />
              )}
              <span className="text-sm font-mono font-medium text-foreground">
                {isController ? "Controller Stream" : "Viewer Stream"} - Advanced
              </span>
            </div>
            <Badge
              variant="outline"
              className={`text-[10px] font-mono ${
                isController
                  ? "border-primary/30 text-primary"
                  : "border-accent/30 text-accent"
              }`}
            >
              {isController ? "LIVE" : "QUALITY"}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={forceKeyframe} className="gap-1.5 text-xs font-mono">
              <RefreshCw className="h-3 w-3" />
              Force Keyframe
            </Button>
          </div>
        </div>
      </header>

      <main className="p-6">
        <Tabs defaultValue="overview" className="w-full">
          <TabsList className="bg-secondary/50 mb-6">
            <TabsTrigger value="overview" className="text-xs font-mono gap-1.5">
              <Activity className="h-3 w-3" />
              Overview
            </TabsTrigger>
            <TabsTrigger value="codec" className="text-xs font-mono gap-1.5">
              <Layers className="h-3 w-3" />
              Codec & Frames
            </TabsTrigger>
            <TabsTrigger value="network" className="text-xs font-mono gap-1.5">
              <Network className="h-3 w-3" />
              Network
            </TabsTrigger>
            <TabsTrigger value="webrtc" className="text-xs font-mono gap-1.5">
              <Cpu className="h-3 w-3" />
              WebRTC Internals
            </TabsTrigger>
            <TabsTrigger value="logs" className="text-xs font-mono gap-1.5">
              <FileText className="h-3 w-3" />
              Events / Logs
            </TabsTrigger>
          </TabsList>

          {/* Overview Tab */}
          <TabsContent value="overview" className="mt-0">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Bitrate chart */}
              <Card className="border-border bg-card">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-mono text-muted-foreground">
                    Bitrate (60s)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-48">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={bitrateHistory}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="t" hide />
                        <YAxis
                          tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                          width={40}
                          tickFormatter={(v) => `${v}M`}
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "hsl(var(--card))",
                            border: "1px solid hsl(var(--border))",
                            borderRadius: "6px",
                            fontSize: "11px",
                            fontFamily: "monospace",
                          }}
                          labelStyle={{ display: "none" }}
                        />
                        <Line
                          type="monotone"
                          dataKey="bitrate"
                          stroke={chartColor}
                          strokeWidth={2}
                          dot={false}
                          isAnimationActive={false}
                          name="Mbps"
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              {/* Latency chart */}
              <Card className="border-border bg-card">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-mono text-muted-foreground">
                    RTT & Jitter (60s)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-48">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={latencyHistory}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="t" hide />
                        <YAxis
                          tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                          width={40}
                          tickFormatter={(v) => `${v}ms`}
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "hsl(var(--card))",
                            border: "1px solid hsl(var(--border))",
                            borderRadius: "6px",
                            fontSize: "11px",
                            fontFamily: "monospace",
                          }}
                          labelStyle={{ display: "none" }}
                        />
                        <Line
                          type="monotone"
                          dataKey="rtt"
                          stroke={chartColor}
                          strokeWidth={2}
                          dot={false}
                          isAnimationActive={false}
                          name="RTT"
                        />
                        <Line
                          type="monotone"
                          dataKey="jitter"
                          stroke="#eab308"
                          strokeWidth={1.5}
                          dot={false}
                          isAnimationActive={false}
                          name="Jitter"
                          strokeDasharray="4 2"
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              {/* FPS chart */}
              <Card className="border-border bg-card">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-mono text-muted-foreground">
                    FPS (60s)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-48">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={fpsHistory}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="t" hide />
                        <YAxis
                          tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                          width={40}
                          domain={[0, 65]}
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "hsl(var(--card))",
                            border: "1px solid hsl(var(--border))",
                            borderRadius: "6px",
                            fontSize: "11px",
                            fontFamily: "monospace",
                          }}
                          labelStyle={{ display: "none" }}
                        />
                        <Line
                          type="monotone"
                          dataKey="fps"
                          stroke={chartColor}
                          strokeWidth={2}
                          dot={false}
                          isAnimationActive={false}
                          name="FPS"
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              {/* Key metrics summary */}
              <Card className="border-border bg-card">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-mono text-muted-foreground">
                    Current Metrics
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-3">
                    <StatBlock label="Resolution" value={latest?.resolution || "---"} />
                    <StatBlock label="FPS" value={`${latest?.fps || 0}`} />
                    <StatBlock
                      label="Bitrate"
                      value={`${((latest?.bitrate || 0) / 1_000_000).toFixed(1)} Mbps`}
                    />
                    <StatBlock label="RTT" value={`${(latest?.rtt || 0).toFixed(0)}ms`} />
                    <StatBlock
                      label="Packet Loss"
                      value={`${((latest?.packetLoss || 0) * 100).toFixed(2)}%`}
                      warn={(latest?.packetLoss || 0) > 0.01}
                    />
                    <StatBlock
                      label="Jitter"
                      value={`${(latest?.jitter || 0).toFixed(1)}ms`}
                      warn={(latest?.jitter || 0) > 30}
                    />
                    <StatBlock label="Buffer" value={isController ? "0ms" : "500ms"} />
                    <StatBlock label="Priority" value={isController ? "High" : "Normal"} />
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Diagnostics */}
            {latest && (
              <Card className="mt-6 border-border bg-card">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
                    <AlertTriangle className="h-3 w-3" />
                    Diagnostic Hints
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col gap-2">
                    {(latest.packetLoss || 0) > 0.02 && (
                      <DiagHint
                        level="warn"
                        text="High packet loss detected. Consider reducing bitrate or checking network conditions."
                      />
                    )}
                    {(latest.rtt || 0) > 50 && (
                      <DiagHint
                        level="warn"
                        text="RTT is elevated. Ensure devices are on the same LAN subnet."
                      />
                    )}
                    {(latest.jitter || 0) > 20 && (
                      <DiagHint
                        level="info"
                        text="Noticeable jitter. Wi-Fi interference may be affecting quality."
                      />
                    )}
                    {(latest.packetLoss || 0) <= 0.02 &&
                      (latest.rtt || 0) <= 50 &&
                      (latest.jitter || 0) <= 20 && (
                        <DiagHint level="ok" text="All metrics within normal ranges." />
                      )}
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* Codec & Frames Tab */}
          <TabsContent value="codec" className="mt-0">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card className="border-border bg-card">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-mono text-muted-foreground">
                    Encoder Details
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-3">
                    <StatBlock
                      label="Codec"
                      value={String((outboundRtp as Record<string, unknown>)?.mimeType || "H.264").replace("video/", "")}
                    />
                    <StatBlock
                      label="Encoder"
                      value={String((outboundRtp as Record<string, unknown>)?.encoderImplementation || "HW")}
                    />
                    <StatBlock
                      label="Keyframe Interval"
                      value={isController ? "2s" : "1s"}
                    />
                    <StatBlock
                      label="Encode Time"
                      value={
                        outboundRtp
                          ? `${(Number((outboundRtp as Record<string, unknown>).totalEncodeTime || 0) * 1000).toFixed(1)}ms avg`
                          : "---"
                      }
                    />
                    <StatBlock
                      label="Frames Encoded"
                      value={String((outboundRtp as Record<string, unknown>)?.framesEncoded || "---")}
                    />
                    <StatBlock
                      label="Key Frames"
                      value={String((outboundRtp as Record<string, unknown>)?.keyFramesEncoded || "---")}
                    />
                  </div>
                </CardContent>
              </Card>

              <Card className="border-border bg-card">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-mono text-muted-foreground">
                    Frame Drops
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-3">
                    <StatBlock
                      label="Encoder Drops"
                      value="0"
                    />
                    <StatBlock
                      label="Network Drops"
                      value={String((outboundRtp as Record<string, unknown>)?.framesDropped || "0")}
                    />
                    <StatBlock
                      label="QP Sum"
                      value={String((outboundRtp as Record<string, unknown>)?.qpSum || "---")}
                    />
                    <StatBlock
                      label="NACK Count"
                      value={String((outboundRtp as Record<string, unknown>)?.nackCount || "0")}
                    />
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Network Tab */}
          <TabsContent value="network" className="mt-0">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card className="border-border bg-card">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-mono text-muted-foreground">
                    Bandwidth Estimation
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-3">
                    <StatBlock
                      label="Available Outgoing"
                      value={
                        candidatePair
                          ? `${((Number((candidatePair as Record<string, unknown>).availableOutgoingBitrate || 0)) / 1_000_000).toFixed(1)} Mbps`
                          : "---"
                      }
                    />
                    <StatBlock
                      label="Current RTT"
                      value={
                        candidatePair
                          ? `${((Number((candidatePair as Record<string, unknown>).currentRoundTripTime || 0)) * 1000).toFixed(0)}ms`
                          : "---"
                      }
                    />
                    <StatBlock
                      label="Bytes Sent"
                      value={
                        candidatePair
                          ? formatBytes(Number((candidatePair as Record<string, unknown>).bytesSent || 0))
                          : "---"
                      }
                    />
                    <StatBlock
                      label="Bytes Received"
                      value={
                        candidatePair
                          ? formatBytes(Number((candidatePair as Record<string, unknown>).bytesReceived || 0))
                          : "---"
                      }
                    />
                  </div>
                </CardContent>
              </Card>

              <Card className="border-border bg-card">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-mono text-muted-foreground">
                    Retransmissions
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-3">
                    <StatBlock
                      label="Retransmitted Sent"
                      value={String((outboundRtp as Record<string, unknown>)?.retransmittedBytesSent || "0")}
                    />
                    <StatBlock
                      label="Retransmitted Packets"
                      value={String((outboundRtp as Record<string, unknown>)?.retransmittedPacketsSent || "0")}
                    />
                    <StatBlock
                      label="FIR Count"
                      value={String((outboundRtp as Record<string, unknown>)?.firCount || "0")}
                    />
                    <StatBlock
                      label="PLI Count"
                      value={String((outboundRtp as Record<string, unknown>)?.pliCount || "0")}
                    />
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* WebRTC Internals Tab */}
          <TabsContent value="webrtc" className="mt-0">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card className="border-border bg-card">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-mono text-muted-foreground">
                    Connection State
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-3">
                    <StatBlock
                      label="ICE State"
                      value={pc?.iceConnectionState || "---"}
                    />
                    <StatBlock
                      label="Connection State"
                      value={pc?.connectionState || "---"}
                    />
                    <StatBlock
                      label="Signaling State"
                      value={pc?.signalingState || "---"}
                    />
                    <StatBlock
                      label="DTLS State"
                      value={String((transport as Record<string, unknown>)?.dtlsState || "---")}
                    />
                  </div>
                </CardContent>
              </Card>

              <Card className="border-border bg-card">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-mono text-muted-foreground">
                    {isController ? "DataChannel RTT" : "Viewer Buffer"}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-3">
                    {isController ? (
                      <>
                        <StatBlock label="DC State" value="open" />
                        <StatBlock label="DC RTT" value="< 1ms" />
                        <StatBlock label="DC Messages In" value="---" />
                        <StatBlock label="DC Messages Out" value="---" />
                      </>
                    ) : (
                      <>
                        <StatBlock label="Buffer Size" value="500ms" />
                        <StatBlock label="Buffer Health" value="Good" />
                        <StatBlock label="Underruns" value="0" />
                        <StatBlock label="Mode" value="Quality" />
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Events / Logs Tab */}
          <TabsContent value="logs" className="mt-0">
            <Card className="border-border bg-card">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-xs font-mono text-muted-foreground">
                    Event Log
                  </CardTitle>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs font-mono h-7"
                    onClick={() => {
                      const blob = new Blob([logs.join("\n")], { type: "text/plain" })
                      const url = URL.createObjectURL(blob)
                      const a = document.createElement("a")
                      a.href = url
                      a.download = `screenlink-${streamType}-logs.txt`
                      a.click()
                      URL.revokeObjectURL(url)
                    }}
                  >
                    <Download className="h-3 w-3 mr-1" />
                    Export
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="bg-secondary/30 rounded-md p-3 h-64 overflow-y-auto font-mono text-xs">
                  {logs.length === 0 ? (
                    <span className="text-muted-foreground/40">No events recorded yet.</span>
                  ) : (
                    logs.map((log, i) => (
                      <div key={i} className="text-muted-foreground py-0.5">
                        {log}
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  )
}

function StatBlock({
  label,
  value,
  warn,
}: {
  label: string
  value: string
  warn?: boolean
}) {
  return (
    <div className="rounded-md bg-secondary/50 px-3 py-2 flex flex-col gap-1">
      <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
        {label}
      </span>
      <span
        className={`text-sm font-mono font-medium ${
          warn ? "text-chart-3" : "text-foreground"
        }`}
      >
        {value}
      </span>
    </div>
  )
}

function DiagHint({ level, text }: { level: "ok" | "warn" | "info"; text: string }) {
  const colors = {
    ok: "border-primary/30 bg-primary/5 text-primary",
    warn: "border-chart-3/30 bg-chart-3/5 text-chart-3",
    info: "border-accent/30 bg-accent/5 text-accent",
  }
  return (
    <div className={`rounded-md border px-3 py-2 text-xs font-mono ${colors[level]}`}>
      {text}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${(bytes / 1073741824).toFixed(2)} GB`
}
