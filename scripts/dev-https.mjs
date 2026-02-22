import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const nextDir = path.join(process.cwd(), ".next")
const persistedApiKeyFile = path.join(nextDir, "host-agent-api-key")

function loadOrCreateAgentApiKey() {
  if (process.env.HOST_AGENT_API_KEY) {
    return process.env.HOST_AGENT_API_KEY
  }

  try {
    if (existsSync(persistedApiKeyFile)) {
      const saved = readFileSync(persistedApiKeyFile, "utf8").trim()
      if (saved.length >= 16) {
        return saved
      }
    }
  } catch {
    // Ignore key read errors and fall back to generating a new key.
  }

  const created = randomBytes(24).toString("hex")
  try {
    if (!existsSync(nextDir)) {
      mkdirSync(nextDir, { recursive: true })
    }
    writeFileSync(persistedApiKeyFile, `${created}\n`, "utf8")
  } catch {
    // Ignore key persistence errors; key still works for this process.
  }
  return created
}

const generatedAgentApiKey = loadOrCreateAgentApiKey()
const env = {
  ...process.env,
  // Avoid mkcert failures on Windows environments where Java truststore is not writable.
  TRUST_STORES: process.env.TRUST_STORES || "system",
  HOST_AGENT_API_KEY: generatedAgentApiKey,
}

const shouldStartAgent = process.env.HOST_AGENT_AUTO_START !== "0"
let agentChild = null

if (shouldStartAgent) {
  agentChild = spawn("node", ["scripts/host-agent.mjs"], {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  })
}

const passthroughArgs = process.argv.slice(2).filter((arg) => arg !== "--")
const args = ["dev", "--experimental-https", ...passthroughArgs]

const child = spawn("next", args, {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
})

const shutdownChildren = () => {
  if (agentChild && !agentChild.killed) {
    agentChild.kill()
  }
  if (child && !child.killed) {
    child.kill()
  }
}

process.on("SIGINT", shutdownChildren)
process.on("SIGTERM", shutdownChildren)

child.on("exit", (code, signal) => {
  if (agentChild && !agentChild.killed) {
    agentChild.kill()
  }
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
