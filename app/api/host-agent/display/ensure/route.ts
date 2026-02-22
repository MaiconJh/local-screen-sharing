import { proxyAgentRequest } from "../../_agent-proxy"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const body = await request.text()
  return proxyAgentRequest("/display/ensure", {
    method: "POST",
    body,
    timeoutMs: 3500,
  })
}

