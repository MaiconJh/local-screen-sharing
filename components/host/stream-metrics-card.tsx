"use client"

import type { ReactNode } from "react"
import {
  ArrowUpRight,
  Gauge,
  Clock,
  Signal,
  Waves,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { StreamStats } from "@/lib/types"
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  YAxis,
} from "recharts"

interface StreamMetricsCardProps {
  title: string
  subtitle: string
  icon: ReactNode
  active: boolean
  stats: StreamStats[]
  accentClass: string
  onDrillDown: () => void
}

export function StreamMetricsCard({
  title,
  subtitle,
  icon,
  active,
  stats,
  accentClass,
  onDrillDown,
}: StreamMetricsCardProps) {
  const latest = stats.length > 0 ? stats[stats.length - 1] : null
  const isController = subtitle === "LIVE"

  const bitrateData = stats.slice(-30).map((s, i) => ({
    i,
    val: s.bitrate / 1_000_000,
  }))
  const rttData = stats.slice(-30).map((s, i) => ({
    i,
    val: s.rtt,
  }))

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm font-mono">
            <span className={accentClass}>{icon}</span>
            {title}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={`text-[10px] font-mono ${
                active
                  ? isController
                    ? "border-primary/30 text-primary"
                    : "border-accent/30 text-accent"
                  : "border-border text-muted-foreground"
              }`}
            >
              {subtitle}
            </Badge>
            {active && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={onDrillDown}
              >
                <ArrowUpRight className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {active && latest ? (
          <div className="flex flex-col gap-4">
            {/* Key metrics grid */}
            <div className="grid grid-cols-2 gap-3">
              <MetricItem
                icon={<Gauge className="h-3 w-3" />}
                label="Resolution"
                value={latest.resolution}
              />
              <MetricItem
                icon={<Signal className="h-3 w-3" />}
                label="FPS"
                value={`${latest.fps}`}
              />
              <MetricItem
                icon={<Waves className="h-3 w-3" />}
                label="Bitrate"
                value={`${(latest.bitrate / 1_000_000).toFixed(1)} Mbps`}
              />
              <MetricItem
                icon={<Clock className="h-3 w-3" />}
                label="RTT"
                value={`${latest.rtt.toFixed(0)}ms`}
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <MetricItemSmall
                label="Pkt Loss"
                value={`${(latest.packetLoss * 100).toFixed(2)}%`}
              />
              <MetricItemSmall
                label="Jitter"
                value={`${latest.jitter.toFixed(1)}ms`}
              />
              <MetricItemSmall
                label="Buffer"
                value={isController ? "0ms" : "500ms"}
              />
            </div>

            {/* Mini charts */}
            <div className="grid grid-cols-2 gap-3">
              <MiniChart
                data={bitrateData}
                label="Bitrate (10s)"
                color={isController ? "hsl(142, 71%, 45%)" : "hsl(217, 91%, 60%)"}
              />
              <MiniChart
                data={rttData}
                label="Latency (10s)"
                color={isController ? "hsl(142, 71%, 45%)" : "hsl(217, 91%, 60%)"}
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 py-6 text-muted-foreground/40">
            <span className="text-xs font-mono">No client connected</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function MetricItem({
  icon,
  label,
  value,
}: {
  icon: ReactNode
  label: string
  value: string
}) {
  return (
    <div className="rounded-md bg-secondary/50 px-3 py-2 flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-[10px] font-mono uppercase tracking-wider">
          {label}
        </span>
      </div>
      <span className="text-sm font-mono text-foreground font-medium">{value}</span>
    </div>
  )
}

function MetricItemSmall({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md bg-secondary/30 px-2 py-1.5">
      <span className="text-[9px] font-mono text-muted-foreground uppercase tracking-wider">
        {label}
      </span>
      <span className="text-xs font-mono text-foreground">{value}</span>
    </div>
  )
}

function MiniChart({
  data,
  label,
  color,
}: {
  data: { i: number; val: number }[]
  label: string
  color: string
}) {
  return (
    <div className="rounded-md bg-secondary/30 p-2 flex flex-col gap-1">
      <span className="text-[9px] font-mono text-muted-foreground uppercase tracking-wider">
        {label}
      </span>
      <div className="h-12">
        {data.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data}>
              <defs>
                <linearGradient id={`grad-${label}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <YAxis domain={["dataMin", "dataMax"]} hide />
              <Area
                type="monotone"
                dataKey="val"
                stroke={color}
                strokeWidth={1.5}
                fill={`url(#grad-${label})`}
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full flex items-center justify-center text-[9px] text-muted-foreground/40 font-mono">
            Collecting...
          </div>
        )}
      </div>
    </div>
  )
}
