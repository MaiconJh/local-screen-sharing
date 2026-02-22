import { proxyAgentRequest } from "../_agent-proxy"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  return proxyAgentRequest("/status", { method: "GET", timeoutMs: 900 })
}

