import { ClientApp } from "@/components/client/client-app"
import { LandingPage } from "@/components/landing-page"
import { sessionStore } from "@/lib/session-store"

export default async function Page({
  searchParams,
}: {
  searchParams?: Promise<{ token?: string }>
}) {
  const resolvedSearchParams = await searchParams
  const token = resolvedSearchParams?.token
  const session = sessionStore.getSession()
  const activeStreamer = session?.active
    ? {
      token: session.token,
      hostLabel: session.hostLabel,
      clientCount: session.clients.length,
    }
    : null

  if (token) {
    return <ClientApp />
  }

  return <LandingPage activeStreamer={activeStreamer} />
}
