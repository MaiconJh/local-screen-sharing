const AGENT_BASE_URL = process.env.HOST_AGENT_BASE_URL || "http://127.0.0.1:47831"
const AGENT_API_KEY = process.env.HOST_AGENT_API_KEY || ""

export async function proxyAgentRequest(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {}
) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? 1200)

  try {
    const response = await fetch(`${AGENT_BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(AGENT_API_KEY ? { "x-host-agent-key": AGENT_API_KEY } : {}),
        ...(init.headers || {}),
      },
      cache: "no-store",
    })

    const text = await response.text()
    return new Response(text, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("content-type") || "application/json",
        "Cache-Control": "no-store",
      },
    })
  } catch {
    return Response.json(
      { error: "Host agent unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    )
  } finally {
    clearTimeout(timeout)
  }
}
