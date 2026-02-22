"use client"

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"
import { ClientApp } from "@/components/client/client-app"
import { LandingPage } from "@/components/landing-page"

function PageContent() {
  const searchParams = useSearchParams()
  const token = searchParams.get("token")

  if (token) {
    return <ClientApp />
  }

  return <LandingPage />
}

export default function Page() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-muted-foreground font-mono text-sm">Loading...</div>
      </div>
    }>
      <PageContent />
    </Suspense>
  )
}
