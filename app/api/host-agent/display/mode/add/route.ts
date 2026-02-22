import { proxyAgentRequest } from "../../../_agent-proxy"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const body = await request.text()
  return proxyAgentRequest("/display/mode/add", {
    method: "POST",
    body,
    timeoutMs: 9000,
  })
}
