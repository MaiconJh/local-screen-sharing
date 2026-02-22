import { Monitor, ArrowRight, Wifi, Shield, Zap, Eye } from "lucide-react"
import useSWR from "swr"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import Link from "next/link"

interface LandingPageProps {
  activeStreamer: {
    token: string
    hostLabel: string
    clientCount: number
  } | null
}

export function LandingPage({ activeStreamer }: LandingPageProps) {

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b border-border">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <Monitor className="h-5 w-5 text-primary" />
            <h1 className="text-lg font-semibold text-foreground font-mono tracking-tight">
              ScreenLink
            </h1>
          </div>
          <Link href="/host">
            <Button variant="default" size="sm" className="gap-1.5 font-mono text-xs">
              Open Host Dashboard
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </Link>
        </div>
      </header>

      {/* Hero */}
      <main className="flex-1 flex items-center justify-center px-6">
        <div className="max-w-2xl w-full flex flex-col items-center gap-8 py-16">
          <div className="flex flex-col items-center gap-4 text-center">
            <Badge
              variant="outline"
              className="text-xs font-mono border-primary/30 text-primary"
            >
              LAN Only - No Cloud
            </Badge>
            <h2 className="text-3xl font-mono font-bold text-foreground text-balance">
              Dual-Stream Screen Sharing with Remote Control
            </h2>
            <p className="text-muted-foreground max-w-md text-balance leading-relaxed">
              Ultra-low latency screen sharing over your local network.
              One controller, one viewer. No accounts, no relay servers.
            </p>
          </div>

          <Separator className="max-w-xs" />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-lg">
            <FeatureCard
              icon={<Zap className="h-4 w-4" />}
              title="Controller Stream"
              description="720p60, zero buffer, ultra-low latency with full input control"
              accent="text-primary"
            />
            <FeatureCard
              icon={<Eye className="h-4 w-4" />}
              title="Viewer Stream"
              description="1080p60, adjustable buffer, enhanced quality mode available"
              accent="text-accent"
            />
            <FeatureCard
              icon={<Wifi className="h-4 w-4" />}
              title="LAN Only"
              description="Direct WebRTC over your local Wi-Fi network, no internet required"
              accent="text-foreground"
            />
            <FeatureCard
              icon={<Shield className="h-4 w-4" />}
              title="QR Access"
              description="Scan to join instantly - token-based, no accounts needed"
              accent="text-foreground"
            />
          </div>

          <div className="rounded-lg bg-secondary/30 border border-border p-4 max-w-lg w-full">
            <p className="text-xs font-mono text-muted-foreground text-center leading-relaxed">
              To start sharing, open the{" "}
              <Link href="/host" className="text-primary underline underline-offset-2">
                Host Dashboard
              </Link>{" "}
              on the machine you want to share. Clients join by scanning the QR code
              displayed there.
            </p>
          </div>

          <div className="w-full max-w-lg rounded-lg border border-border bg-card p-4">
            <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Transmissões ativas</p>
            {activeStreamer ? (
              <div className="mt-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-mono text-foreground">{activeStreamer.hostLabel || "Host"}</p>
                  <p className="text-xs text-muted-foreground">{activeStreamer.clientCount || 0}/2 conectados</p>
                </div>
                <Link href={`/join?token=${activeStreamer.token}`}>
                  <Button size="sm" className="font-mono text-xs">Ver transmissão</Button>
                </Link>
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">Nenhum host transmitindo no momento.</p>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}

function FeatureCard({
  icon,
  title,
  description,
  accent,
}: {
  icon: React.ReactNode
  title: string
  description: string
  accent: string
}) {
  return (
    <Card className="border-border bg-card">
      <CardContent className="flex flex-col gap-2 p-4">
        <div className="flex items-center gap-2">
          <span className={accent}>{icon}</span>
          <span className="text-sm font-mono font-medium text-foreground">{title}</span>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
      </CardContent>
    </Card>
  )
}
