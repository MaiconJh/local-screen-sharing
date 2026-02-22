import { proxyAgentRequest } from "../../_agent-proxy"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  return proxyAgentRequest("/display/profile", { method: "GET", timeoutMs: 1200 })
}

export async function POST(request: Request) {
  const body = await request.text()
  return proxyAgentRequest("/display/profile", {
    method: "POST",
    body,
    timeoutMs: 4500,
  })
}
