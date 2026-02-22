import { proxyAgentRequest } from "../../_agent-proxy"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  return proxyAgentRequest("/display/status", { method: "GET", timeoutMs: 1200 })
}

