"use client"

import { Suspense } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { useEffect } from "react"
import { ClientApp } from "@/components/client/client-app"

function JoinContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const token = searchParams.get("token")
  const code = searchParams.get("code")

  useEffect(() => {
    if (!token) {
      router.replace("/")
    }
  }, [token, router])

  if (!token) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-muted-foreground font-mono text-sm">Redirecting...</div>
      </div>
    )
  }

  return <ClientApp initialToken={token} initialCode={code} />
}

export default function JoinPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-background flex items-center justify-center">
          <div className="text-muted-foreground font-mono text-sm">Loading...</div>
        </div>
      }
    >
      <JoinContent />
    </Suspense>
  )
}
