export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const AGENT_BASE_URL = process.env.HOST_AGENT_BASE_URL || "http://127.0.0.1:47831"
const AGENT_API_KEY = process.env.HOST_AGENT_API_KEY || ""

export async function GET(request: Request) {
  try {
    const upstream = await fetch(`${AGENT_BASE_URL}/events`, {
      method: "GET",
      cache: "no-store",
      signal: request.signal,
      headers: {
        ...(AGENT_API_KEY ? { "x-host-agent-key": AGENT_API_KEY } : {}),
      },
    })

    if (!upstream.ok || !upstream.body) {
      return Response.json(
        { error: "Unable to connect to host agent stream" },
        { status: upstream.status || 503 }
      )
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    })
  } catch {
    return Response.json(
      { error: "Host agent stream unavailable" },
      { status: 503 }
    )
  }
}

