import { createServer } from "node:http"
import { spawn } from "node:child_process"

const HOST = process.env.HOST_AGENT_HOST || "127.0.0.1"
const PORT = Number(process.env.HOST_AGENT_PORT || 47831)
const VERSION = process.env.HOST_AGENT_VERSION || "0.1.0"
const CAPTURE_MODE = process.env.HOST_AGENT_CAPTURE_MODE || "desktop-capture"
const API_KEY = process.env.HOST_AGENT_API_KEY || ""
const DISPLAY_PROVIDER = process.env.HOST_AGENT_DISPLAY_PROVIDER || "windows-display-switch"
const DISPLAY_CREATE_CMD = process.env.HOST_AGENT_DISPLAY_CREATE_CMD || ""
const DISPLAY_RELEASE_CMD = process.env.HOST_AGENT_DISPLAY_RELEASE_CMD || ""
const DISPLAY_STATUS_CMD = process.env.HOST_AGENT_DISPLAY_STATUS_CMD || ""
const DISPLAY_CONFIGURE_CMD = process.env.HOST_AGENT_DISPLAY_CONFIGURE_CMD || ""
const DISPLAY_ADD_MODE_CMD = process.env.HOST_AGENT_DISPLAY_ADD_MODE_CMD || ""
const DISPLAY_REMOVE_MODE_CMD = process.env.HOST_AGENT_DISPLAY_REMOVE_MODE_CMD || ""
const DISPLAY_AUTO_CREATE = process.env.HOST_AGENT_DISPLAY_AUTO_CREATE !== "0"
const DISPLAY_AUTO_RELEASE = process.env.HOST_AGENT_DISPLAY_AUTO_RELEASE === "1"
const DISPLAY_AUTO_CONFIGURE = process.env.HOST_AGENT_DISPLAY_AUTO_CONFIGURE !== "0"

const DISPLAY_PROFILE_LIMITS = {
  width: { min: 640, max: 7680 },
  height: { min: 360, max: 4320 },
  refreshHz: { min: 24, max: 240 },
  dpi: { min: 72, max: 400 },
  scalePercent: { min: 50, max: 300 },
  colorDepth: { min: 6, max: 16 },
  monitorId: { min: 1, max: 16 },
}

const FALLBACK_DISPLAY_PROFILE = {
  width: 1920,
  height: 1080,
  refreshHz: 60,
  dpi: 96,
  scalePercent: 100,
  colorDepth: 8,
  monitorId: 2,
  orientation: "landscape",
}

function clampInt(value, fallback, min, max) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

function normalizeOrientation(value, fallback = "landscape") {
  if (value === "portrait") return "portrait"
  if (value === "landscape") return "landscape"
  return fallback
}

function mergeDisplayProfile(base, patch) {
  const source = patch || {}
  return {
    width: clampInt(
      source.width,
      base.width,
      DISPLAY_PROFILE_LIMITS.width.min,
      DISPLAY_PROFILE_LIMITS.width.max
    ),
    height: clampInt(
      source.height,
      base.height,
      DISPLAY_PROFILE_LIMITS.height.min,
      DISPLAY_PROFILE_LIMITS.height.max
    ),
    refreshHz: clampInt(
      source.refreshHz,
      base.refreshHz,
      DISPLAY_PROFILE_LIMITS.refreshHz.min,
      DISPLAY_PROFILE_LIMITS.refreshHz.max
    ),
    dpi: clampInt(
      source.dpi,
      base.dpi,
      DISPLAY_PROFILE_LIMITS.dpi.min,
      DISPLAY_PROFILE_LIMITS.dpi.max
    ),
    scalePercent: clampInt(
      source.scalePercent,
      base.scalePercent,
      DISPLAY_PROFILE_LIMITS.scalePercent.min,
      DISPLAY_PROFILE_LIMITS.scalePercent.max
    ),
    colorDepth: clampInt(
      source.colorDepth,
      base.colorDepth,
      DISPLAY_PROFILE_LIMITS.colorDepth.min,
      DISPLAY_PROFILE_LIMITS.colorDepth.max
    ),
    monitorId: clampInt(
      source.monitorId,
      base.monitorId,
      DISPLAY_PROFILE_LIMITS.monitorId.min,
      DISPLAY_PROFILE_LIMITS.monitorId.max
    ),
    orientation: normalizeOrientation(source.orientation, base.orientation),
  }
}

/** @type {{sessionId: string, hostId: string, token: string, profile: "low-latency" | "balanced", startedAt: number} | null} */
let activeSession = null
const bootAt = Date.now()
const sseClients = new Set()
/** @type {{width: number, height: number, refreshHz: number, dpi: number, scalePercent: number, colorDepth: number, monitorId: number, orientation: "landscape" | "portrait"}} */
let displayProfile = mergeDisplayProfile(FALLBACK_DISPLAY_PROFILE, {
  width: process.env.HOST_AGENT_DISPLAY_WIDTH,
  height: process.env.HOST_AGENT_DISPLAY_HEIGHT,
  refreshHz: process.env.HOST_AGENT_DISPLAY_REFRESH_HZ,
  dpi: process.env.HOST_AGENT_DISPLAY_DPI,
  scalePercent: process.env.HOST_AGENT_DISPLAY_SCALE_PERCENT,
  colorDepth: process.env.HOST_AGENT_DISPLAY_COLOR_DEPTH,
  monitorId: process.env.HOST_AGENT_DISPLAY_MONITOR_ID,
  orientation: process.env.HOST_AGENT_DISPLAY_ORIENTATION,
})
/** @type {{provider: string, available: boolean, active: boolean, mode: "extend" | "unknown", lastError: string | null, lastActionAt: number | null, lastOutput: string | null, detectedMonitorIds: number[], detectedModes: Array<{width: number, height: number, hz: number, bitDepth: number, current: boolean}>, targetMonitorFound: boolean | null}} */
let displayState = {
  provider: DISPLAY_PROVIDER,
  available: DISPLAY_PROVIDER !== "none",
  active: false,
  mode: "unknown",
  lastError: null,
  lastActionAt: null,
  lastOutput: null,
  detectedMonitorIds: [],
  detectedModes: [],
  targetMonitorFound: null,
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  })
  res.end(JSON.stringify(payload))
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ""
    req.on("data", (chunk) => {
      body += chunk
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"))
      }
    })
    req.on("end", () => {
      if (!body) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch {
        reject(new Error("Invalid JSON"))
      }
    })
    req.on("error", reject)
  })
}

function getDisplayProfile() {
  return { ...displayProfile }
}

function getDisplayProfileCapabilities() {
  return {
    width: DISPLAY_PROFILE_LIMITS.width,
    height: DISPLAY_PROFILE_LIMITS.height,
    refreshHz: DISPLAY_PROFILE_LIMITS.refreshHz,
    dpi: DISPLAY_PROFILE_LIMITS.dpi,
    scalePercent: DISPLAY_PROFILE_LIMITS.scalePercent,
    colorDepth: DISPLAY_PROFILE_LIMITS.colorDepth,
    monitorId: DISPLAY_PROFILE_LIMITS.monitorId,
    orientation: ["landscape", "portrait"],
  }
}

function updateDisplayProfile(patch) {
  displayProfile = mergeDisplayProfile(displayProfile, patch)
  return getDisplayProfile()
}

function getDisplayStatus() {
  return {
    provider: displayState.provider,
    available: displayState.available,
    active: displayState.active,
    mode: displayState.mode,
    profile: getDisplayProfile(),
    detectedMonitorIds: displayState.detectedMonitorIds,
    detectedModes: displayState.detectedModes,
    targetMonitorFound: displayState.targetMonitorFound,
    lastError: displayState.lastError,
    lastActionAt: displayState.lastActionAt,
    lastOutput: displayState.lastOutput,
  }
}

function setDisplayState(next) {
  displayState = {
    ...displayState,
    ...next,
    lastActionAt: Date.now(),
  }
}

async function runShellCommand(command, timeoutMs = 12000) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let done = false

    const finish = (result) => {
      if (done) return
      done = true
      resolve(result)
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("exit", (code) => {
      finish({ code: code ?? 0, stdout, stderr })
    })

    const timeout = setTimeout(() => {
      if (!done) {
        child.kill("SIGTERM")
        finish({ code: 124, stdout, stderr: `${stderr}\nCommand timeout` })
      }
    }, timeoutMs)

    child.on("exit", () => clearTimeout(timeout))
  })
}

function isSetResolutionCommand(command) {
  return typeof command === "string" && /setresolution(\.exe)?/i.test(command)
}

function extractExecutableToken(command) {
  if (!command || typeof command !== "string") return null
  const trimmed = command.trim()
  if (!trimmed) return null
  if (trimmed.startsWith("\"")) {
    const endQuote = trimmed.indexOf("\"", 1)
    if (endQuote > 1) return trimmed.slice(0, endQuote + 1)
    return null
  }
  const token = trimmed.match(/^\S+/)
  return token ? token[0] : null
}

function parseSetResolutionCommandMonitorId(command) {
  if (!command || typeof command !== "string") return null
  const inlineMatch = command.match(/(?:^|\s)-m(\d+)(?:\s|$)/i)
  if (inlineMatch) return Number(inlineMatch[1])
  const spacedMatch = command.match(/(?:^|\s)-m\s+(\d+)(?:\s|$)/i)
  if (spacedMatch) return Number(spacedMatch[1])
  return null
}

function getSetResolutionExecutableToken() {
  const candidates = [DISPLAY_STATUS_CMD, DISPLAY_CONFIGURE_CMD, DISPLAY_CREATE_CMD]
  for (const candidate of candidates) {
    if (!isSetResolutionCommand(candidate)) continue
    const executable = extractExecutableToken(candidate)
    if (executable) return executable
  }
  return null
}

function buildSetResolutionListCommand(executableToken, monitorId = null) {
  if (!executableToken) return null
  if (Number.isFinite(monitorId)) {
    return `${executableToken} LIST -m${monitorId} -la`
  }
  return `${executableToken} LIST -la`
}

function parseSetResolutionModes(output) {
  if (!output) return []
  const modes = []
  const lines = output.split(/\r?\n/)
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\s*x\s*(\d+),\s*(\d+)hz,\s*(\d+)bit\s*(\*)?\s*$/i)
    if (!m) continue
    modes.push({
      width: Number(m[1]),
      height: Number(m[2]),
      hz: Number(m[3]),
      bitDepth: Number(m[4]),
      current: Boolean(m[5]),
    })
  }
  return modes
}

function parseSetResolutionMonitorIds(output) {
  if (!output) return []
  const monitorIds = []
  const lines = output.split(/\r?\n/)
  let inMonitorSection = false
  for (const line of lines) {
    if (/^Available Monitors/i.test(line.trim())) {
      inMonitorSection = true
      continue
    }
    if (inMonitorSection && /^Available Display Modes/i.test(line.trim())) {
      break
    }
    if (!inMonitorSection) continue
    const m = line.match(/^\s*(\d+)\s+/)
    if (!m) continue
    monitorIds.push(Number(m[1]))
  }
  return Array.from(new Set(monitorIds))
}

function extractSetResolutionSnapshot(output, targetMonitorId) {
  const monitorIds = parseSetResolutionMonitorIds(output)
  const modes = parseSetResolutionModes(output)
  const targetMonitorFound = monitorIds.includes(Number(targetMonitorId))
  return {
    monitorIds,
    modes,
    targetMonitorFound,
  }
}

function summarizeModes(modes, limit = 8) {
  if (!modes.length) return "No parsed modes"
  return modes
    .slice(0, limit)
    .map((m) => `${m.width}x${m.height}@${m.hz}`)
    .join(", ")
}

function normalizeSetResolutionSnapshot(snapshot, fallbackMonitorId = null) {
  const monitorIds = Array.from(new Set(snapshot.monitorIds || []))
  let targetMonitorFound = Boolean(snapshot.targetMonitorFound)
  if (!targetMonitorFound && Number.isFinite(fallbackMonitorId) && (snapshot.modes || []).length > 0) {
    targetMonitorFound = true
    if (!monitorIds.includes(fallbackMonitorId)) {
      monitorIds.push(fallbackMonitorId)
    }
  }
  return {
    monitorIds,
    modes: snapshot.modes || [],
    targetMonitorFound,
  }
}

function getEnsureCommand(mode) {
  if (DISPLAY_PROVIDER === "none") return null
  if (DISPLAY_PROVIDER === "windows-display-switch") {
    return mode === "extend" ? "DisplaySwitch.exe /extend" : "DisplaySwitch.exe /extend"
  }
  if (DISPLAY_PROVIDER === "custom-cli") {
    return DISPLAY_CREATE_CMD || null
  }
  return null
}

function getReleaseCommand() {
  if (DISPLAY_PROVIDER === "none") return null
  if (DISPLAY_PROVIDER === "windows-display-switch") {
    return "DisplaySwitch.exe /internal"
  }
  if (DISPLAY_PROVIDER === "custom-cli") {
    return DISPLAY_RELEASE_CMD || null
  }
  return null
}

function getProbeCommand() {
  if (DISPLAY_PROVIDER === "none") return null
  if (DISPLAY_PROVIDER === "windows-display-switch") {
    return DISPLAY_STATUS_CMD || "where DisplaySwitch.exe"
  }
  if (DISPLAY_PROVIDER === "custom-cli") {
    if (DISPLAY_STATUS_CMD) return DISPLAY_STATUS_CMD
    const setResolutionExecutable = getSetResolutionExecutableToken()
    if (setResolutionExecutable) {
      return buildSetResolutionListCommand(setResolutionExecutable)
    }
    return null
  }
  return null
}

function getConfigureCommand() {
  if (DISPLAY_PROVIDER === "none") return null
  if (DISPLAY_PROVIDER === "custom-cli") {
    return DISPLAY_CONFIGURE_CMD || null
  }
  return null
}

function getConfigureSupport() {
  if (DISPLAY_PROVIDER === "none") {
    return { supported: false, reason: "Display provider disabled" }
  }
  if (DISPLAY_PROVIDER === "windows-display-switch") {
    return {
      supported: false,
      reason: "windows-display-switch does not apply resolution/DPI. Use custom-cli + HOST_AGENT_DISPLAY_CONFIGURE_CMD.",
    }
  }
  if (DISPLAY_PROVIDER === "custom-cli") {
    if (!DISPLAY_CONFIGURE_CMD) {
      return {
        supported: false,
        reason: "No configure command configured. Set HOST_AGENT_DISPLAY_CONFIGURE_CMD.",
      }
    }
    return { supported: true, reason: null }
  }
  return {
    supported: false,
    reason: `Unknown display provider '${DISPLAY_PROVIDER}'`,
  }
}

function getModeCommandSupport(action) {
  const command = action === "add" ? DISPLAY_ADD_MODE_CMD : DISPLAY_REMOVE_MODE_CMD
  const envName = action === "add" ? "HOST_AGENT_DISPLAY_ADD_MODE_CMD" : "HOST_AGENT_DISPLAY_REMOVE_MODE_CMD"
  if (DISPLAY_PROVIDER === "none") {
    return { supported: false, reason: "Display provider disabled" }
  }
  if (DISPLAY_PROVIDER === "windows-display-switch") {
    return {
      supported: false,
      reason: "windows-display-switch does not support add/remove display modes.",
    }
  }
  if (DISPLAY_PROVIDER !== "custom-cli") {
    return {
      supported: false,
      reason: `Unknown display provider '${DISPLAY_PROVIDER}'`,
    }
  }
  if (!command) {
    return {
      supported: false,
      reason: `No ${action} mode command configured. Set ${envName}.`,
    }
  }
  return { supported: true, reason: null }
}

function getDisplaySupportSnapshot() {
  const configure = getConfigureSupport()
  const addMode = getModeCommandSupport("add")
  const removeMode = getModeCommandSupport("remove")
  return {
    configureSupported: configure.supported,
    configureReason: configure.reason,
    addModeSupported: addMode.supported,
    addModeReason: addMode.reason,
    removeModeSupported: removeMode.supported,
    removeModeReason: removeMode.reason,
  }
}

function applyCommandTemplate(command) {
  if (!command) return command
  return command
    .replaceAll("{sessionId}", activeSession?.sessionId || "")
    .replaceAll("{hostId}", activeSession?.hostId || "")
    .replaceAll("{profile}", activeSession?.profile || "")
    .replaceAll("{width}", String(displayProfile.width))
    .replaceAll("{height}", String(displayProfile.height))
    .replaceAll("{refreshHz}", String(displayProfile.refreshHz))
    .replaceAll("{dpi}", String(displayProfile.dpi))
    .replaceAll("{scalePercent}", String(displayProfile.scalePercent))
    .replaceAll("{colorDepth}", String(displayProfile.colorDepth))
    .replaceAll("{monitorId}", String(displayProfile.monitorId))
    .replaceAll("{orientation}", displayProfile.orientation)
}

async function configureDisplay() {
  if (displayState.provider === "none") {
    setDisplayState({
      available: false,
      lastError: "Display provider disabled",
      lastOutput: null,
    })
    return { success: false, applied: false, status: getDisplayStatus(), error: displayState.lastError }
  }

  const rawCmd = getConfigureCommand()
  if (!rawCmd) {
    const support = getConfigureSupport()
    setDisplayState({
      available: true,
      lastError: null,
      lastOutput: support.reason || "Display profile stored. Provider has no configure command.",
    })
    return {
      success: true,
      applied: false,
      status: getDisplayStatus(),
      warning: support.reason || `No configure command configured for provider '${displayState.provider}'`,
    }
  }

  if (DISPLAY_PROVIDER === "custom-cli" && isSetResolutionCommand(rawCmd)) {
    const executableToken = getSetResolutionExecutableToken()
    if (!executableToken) {
      setDisplayState({
        available: false,
        lastError: "Unable to infer setresolution executable for preflight",
        lastOutput: rawCmd,
      })
      return { success: false, applied: false, status: getDisplayStatus(), error: displayState.lastError }
    }

    const targetMonitorId = Number(displayProfile.monitorId)
    const monitorProbeCmd = buildSetResolutionListCommand(executableToken)
    const monitorProbeResult = await runShellCommand(monitorProbeCmd, 10000)
    if (monitorProbeResult.code !== 0) {
      setDisplayState({
        available: false,
        lastError: `Display preflight failed while listing monitors (code ${monitorProbeResult.code})`,
        lastOutput: (monitorProbeResult.stderr || monitorProbeResult.stdout || "").trim() || null,
      })
      return { success: false, applied: false, status: getDisplayStatus(), error: displayState.lastError }
    }

    const monitorProbeText = `${monitorProbeResult.stdout || ""}\n${monitorProbeResult.stderr || ""}`.trim()
    const monitorSnapshot = normalizeSetResolutionSnapshot(
      extractSetResolutionSnapshot(monitorProbeText, displayProfile.monitorId)
    )
    if (!monitorSnapshot.targetMonitorFound) {
      setDisplayState({
        detectedMonitorIds: monitorSnapshot.monitorIds,
        detectedModes: monitorSnapshot.modes,
        targetMonitorFound: false,
        available: true,
        lastError: `Monitor ${displayProfile.monitorId} not found by setresolution`,
        lastOutput: `Detected monitors: ${monitorSnapshot.monitorIds.join(", ") || "none"}`,
      })
      return { success: false, applied: false, status: getDisplayStatus(), error: displayState.lastError }
    }

    const targetProbeCmd = buildSetResolutionListCommand(executableToken, targetMonitorId)
    const targetProbeResult = await runShellCommand(targetProbeCmd, 10000)
    if (targetProbeResult.code !== 0) {
      setDisplayState({
        detectedMonitorIds: monitorSnapshot.monitorIds,
        detectedModes: monitorSnapshot.modes,
        targetMonitorFound: true,
        available: false,
        lastError: `Display preflight failed while listing modes for monitor ${targetMonitorId} (code ${targetProbeResult.code})`,
        lastOutput: (targetProbeResult.stderr || targetProbeResult.stdout || "").trim() || null,
      })
      return { success: false, applied: false, status: getDisplayStatus(), error: displayState.lastError }
    }

    const targetProbeText = `${targetProbeResult.stdout || ""}\n${targetProbeResult.stderr || ""}`.trim()
    const targetSnapshot = normalizeSetResolutionSnapshot(
      extractSetResolutionSnapshot(targetProbeText, displayProfile.monitorId),
      targetMonitorId
    )
    const effectiveModes = targetSnapshot.modes.length > 0 ? targetSnapshot.modes : monitorSnapshot.modes
    setDisplayState({
      detectedMonitorIds: monitorSnapshot.monitorIds,
      detectedModes: effectiveModes,
      targetMonitorFound: true,
    })

    if (effectiveModes.length > 0) {
      const hasMode = effectiveModes.some(
        (mode) => mode.width === displayProfile.width && mode.height === displayProfile.height
      )
      if (!hasMode) {
        const summary = summarizeModes(effectiveModes)
        setDisplayState({
          available: true,
          lastError: `Requested mode ${displayProfile.width}x${displayProfile.height} not available on monitor ${displayProfile.monitorId}`,
          lastOutput: `Available modes (sample): ${summary}`,
        })
        return { success: false, applied: false, status: getDisplayStatus(), error: displayState.lastError }
      }
    }
  }

  const cmd = applyCommandTemplate(rawCmd)
  const result = await runShellCommand(cmd)
  if (result.code !== 0) {
    setDisplayState({
      available: false,
      lastError: `Display configure command failed (code ${result.code})`,
      lastOutput: (result.stderr || result.stdout || "").trim() || null,
    })
    return { success: false, applied: true, status: getDisplayStatus(), error: displayState.lastError }
  }

  setDisplayState({
    available: true,
    lastError: null,
    lastOutput: (result.stdout || result.stderr || "").trim() || "Display profile applied",
  })
  return { success: true, applied: true, status: getDisplayStatus() }
}

function getModeCommand(action) {
  if (action === "add") return DISPLAY_ADD_MODE_CMD || null
  if (action === "remove") return DISPLAY_REMOVE_MODE_CMD || null
  return null
}

async function applyDisplayModeCommand(action) {
  const support = getModeCommandSupport(action)
  if (!support.supported) {
    setDisplayState({
      available: true,
      lastError: support.reason,
      lastOutput: support.reason,
    })
    return { success: false, applied: false, status: getDisplayStatus(), error: support.reason }
  }

  const rawCmd = getModeCommand(action)
  if (!rawCmd) {
    const reason = `No ${action} mode command configured`
    setDisplayState({
      available: true,
      lastError: reason,
      lastOutput: reason,
    })
    return { success: false, applied: false, status: getDisplayStatus(), error: reason }
  }

  const cmd = applyCommandTemplate(rawCmd)
  const result = await runShellCommand(cmd)
  if (result.code !== 0) {
    setDisplayState({
      available: false,
      lastError: `Display ${action} mode command failed (code ${result.code})`,
      lastOutput: (result.stderr || result.stdout || "").trim() || null,
    })
    return { success: false, applied: true, status: getDisplayStatus(), error: displayState.lastError }
  }

  setDisplayState({
    available: true,
    lastError: null,
    lastOutput: (result.stdout || result.stderr || "").trim() || `Display mode ${action} command applied`,
  })
  return { success: true, applied: true, status: getDisplayStatus() }
}

async function probeDisplay() {
  if (displayState.provider === "none") {
    setDisplayState({
      available: false,
      lastError: "Display provider disabled",
      lastOutput: null,
    })
    return { success: false, status: getDisplayStatus(), error: displayState.lastError }
  }

  const rawCmd = getProbeCommand()
  if (!rawCmd) {
    setDisplayState({
      available: false,
      lastError: `No probe command configured for provider '${displayState.provider}'`,
      lastOutput: null,
    })
    return { success: false, status: getDisplayStatus(), error: displayState.lastError }
  }

  const cmd = applyCommandTemplate(rawCmd)
  const result = await runShellCommand(cmd, 8000)
  if (result.code !== 0) {
    setDisplayState({
      available: false,
      lastError: `Display provider probe failed (code ${result.code})`,
      lastOutput: (result.stderr || result.stdout || "").trim() || null,
    })
    return { success: false, status: getDisplayStatus(), error: displayState.lastError }
  }

  const probeText = `${result.stdout || ""}\n${result.stderr || ""}`.trim()
  if (DISPLAY_PROVIDER === "custom-cli" && isSetResolutionCommand(rawCmd)) {
    const parsedMonitorId = parseSetResolutionCommandMonitorId(rawCmd)
    const snapshot = normalizeSetResolutionSnapshot(
      extractSetResolutionSnapshot(probeText, displayProfile.monitorId),
      parsedMonitorId
    )
    setDisplayState({
      detectedMonitorIds: snapshot.monitorIds,
      detectedModes: snapshot.modes,
      targetMonitorFound: snapshot.targetMonitorFound,
    })
  }

  setDisplayState({
    available: true,
    lastError: null,
    lastOutput: probeText || null,
  })
  return { success: true, status: getDisplayStatus() }
}

async function ensureDisplay(mode = "extend", options = {}) {
  if (displayState.provider === "none") {
    setDisplayState({
      available: false,
      active: false,
      mode: "unknown",
      lastError: "Display provider disabled",
      lastOutput: null,
    })
    return { success: false, status: getDisplayStatus(), error: displayState.lastError }
  }

  let displayConfigure = null
  if (DISPLAY_AUTO_CONFIGURE && !options.skipConfigure) {
    displayConfigure = await configureDisplay()
    if (!displayConfigure.success) {
      return {
        success: false,
        status: getDisplayStatus(),
        error: displayConfigure.error || "Display configure failed",
        displayConfigure,
      }
    }
  }

  const rawCmd = getEnsureCommand(mode)
  if (!rawCmd) {
    setDisplayState({
      active: false,
      mode: "unknown",
      lastError: `No create command configured for provider '${displayState.provider}'`,
      lastOutput: null,
    })
    return {
      success: false,
      status: getDisplayStatus(),
      error: displayState.lastError,
      displayConfigure,
    }
  }

  const cmd = applyCommandTemplate(rawCmd)
  const result = await runShellCommand(cmd)
  if (result.code !== 0) {
    setDisplayState({
      active: false,
      mode: "unknown",
      lastError: `Display ensure command failed (code ${result.code})`,
      lastOutput: (result.stderr || result.stdout || "").trim() || null,
    })
    return {
      success: false,
      status: getDisplayStatus(),
      error: displayState.lastError,
      displayConfigure,
    }
  }

  setDisplayState({
    available: true,
    active: true,
    mode: "extend",
    lastError: null,
    lastOutput: (result.stdout || result.stderr || "").trim() || null,
  })
  return { success: true, status: getDisplayStatus(), displayConfigure }
}

async function releaseDisplay() {
  if (displayState.provider === "none") {
    return { success: true, status: getDisplayStatus() }
  }

  const rawCmd = getReleaseCommand()
  if (!rawCmd) {
    setDisplayState({
      lastError: `No release command configured for provider '${displayState.provider}'`,
      lastOutput: null,
    })
    return { success: false, status: getDisplayStatus(), error: displayState.lastError }
  }

  const cmd = applyCommandTemplate(rawCmd)
  const result = await runShellCommand(cmd)
  if (result.code !== 0) {
    setDisplayState({
      lastError: `Display release command failed (code ${result.code})`,
      lastOutput: (result.stderr || result.stdout || "").trim() || null,
    })
    return { success: false, status: getDisplayStatus(), error: displayState.lastError }
  }

  setDisplayState({
    active: false,
    mode: "unknown",
    lastError: null,
    lastOutput: (result.stdout || result.stderr || "").trim() || null,
  })
  return { success: true, status: getDisplayStatus() }
}

function currentStatus() {
  return {
    running: Boolean(activeSession),
    version: VERSION,
    captureMode: CAPTURE_MODE,
    uptimeMs: Date.now() - bootAt,
    pid: process.pid,
    sessionId: activeSession?.sessionId ?? null,
    profile: activeSession?.profile ?? null,
    startedAt: activeSession?.startedAt ?? null,
    authRequired: Boolean(API_KEY),
    display: getDisplayStatus(),
  }
}

function currentTelemetry() {
  const mem = process.memoryUsage()
  return {
    timestamp: Date.now(),
    uptimeMs: Date.now() - bootAt,
    sessionRunning: Boolean(activeSession),
    displayActive: Boolean(displayState.active),
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
  }
}

function isAuthorized(req) {
  if (!API_KEY) return true
  const headerValue = req.headers["x-host-agent-key"]
  return typeof headerValue === "string" && headerValue === API_KEY
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function broadcastSse(payload) {
  for (const res of Array.from(sseClients)) {
    try {
      writeSse(res, payload)
    } catch {
      sseClients.delete(res)
    }
  }
}

const server = createServer(async (req, res) => {
  const method = req.method || "GET"
  const url = req.url || "/"

  if (!isAuthorized(req)) {
    sendJson(res, 401, { success: false, error: "Unauthorized host-agent request" })
    return
  }

  if (method === "GET" && url === "/status") {
    sendJson(res, 200, currentStatus())
    return
  }

  if (method === "GET" && url === "/display/status") {
    sendJson(res, 200, getDisplayStatus())
    return
  }

  if (method === "GET" && url === "/display/profile") {
    const support = getDisplaySupportSnapshot()
    sendJson(res, 200, {
      success: true,
      profile: getDisplayProfile(),
      capabilities: getDisplayProfileCapabilities(),
      ...support,
      status: getDisplayStatus(),
    })
    return
  }

  if (method === "POST" && url === "/display/profile") {
    try {
      const payload = /** @type {any} */ (await readJson(req))
      const nextProfile = updateDisplayProfile(payload?.profile || {})
      const configureSupport = getConfigureSupport()
      const support = getDisplaySupportSnapshot()

      let configureResult = null
      if (payload?.applyNow) {
        if (!configureSupport.supported) {
          setDisplayState({
            lastError: configureSupport.reason,
            lastOutput: configureSupport.reason,
          })
          broadcastSse({
            type: "status",
            status: currentStatus(),
          })
          sendJson(res, 409, {
            success: false,
            error: configureSupport.reason,
            profile: nextProfile,
            ...support,
            configure: {
              success: false,
              applied: false,
              error: configureSupport.reason,
              status: getDisplayStatus(),
            },
            status: getDisplayStatus(),
          })
          return
        }
        if (DISPLAY_PROVIDER === "custom-cli" && !displayState.active) {
          const prepared = await ensureDisplay("extend", { skipConfigure: true })
          if (!prepared.success) {
            broadcastSse({
              type: "status",
              status: currentStatus(),
            })
            sendJson(res, 409, {
              success: false,
              error: prepared.error || "Failed to prepare display before applying profile",
              profile: nextProfile,
              ...support,
              prepare: prepared,
              status: getDisplayStatus(),
            })
            return
          }
        }
        configureResult = await configureDisplay()
      } else {
        setDisplayState({
          lastError: null,
          lastOutput: "Display profile updated",
        })
      }

      broadcastSse({
        type: "status",
        status: currentStatus(),
      })

      const ok = !configureResult || configureResult.success
      sendJson(res, ok ? 200 : 409, {
        success: ok,
        profile: nextProfile,
        ...support,
        configure: configureResult,
        status: getDisplayStatus(),
      })
      return
    } catch (error) {
      sendJson(res, 400, {
        success: false,
        error: error instanceof Error ? error.message : "Bad request",
        profile: getDisplayProfile(),
        ...getDisplaySupportSnapshot(),
        status: getDisplayStatus(),
      })
      return
    }
  }

  if (method === "POST" && url === "/display/configure") {
    try {
      const payload = /** @type {any} */ (await readJson(req))
      if (payload?.profile) {
        updateDisplayProfile(payload.profile)
      }
      const configureSupport = getConfigureSupport()
      const support = getDisplaySupportSnapshot()
      if (!configureSupport.supported) {
        setDisplayState({
          lastError: configureSupport.reason,
          lastOutput: configureSupport.reason,
        })
        broadcastSse({
          type: "status",
          status: currentStatus(),
        })
        sendJson(res, 409, {
          success: false,
          error: configureSupport.reason,
          applied: false,
          profile: getDisplayProfile(),
          ...support,
          status: getDisplayStatus(),
        })
        return
      }
      if (DISPLAY_PROVIDER === "custom-cli" && !displayState.active) {
        const prepared = await ensureDisplay("extend", { skipConfigure: true })
        if (!prepared.success) {
          broadcastSse({
            type: "status",
            status: currentStatus(),
          })
          sendJson(res, 409, {
            success: false,
            error: prepared.error || "Failed to prepare display before configure",
            applied: false,
            profile: getDisplayProfile(),
            ...support,
            prepare: prepared,
            status: getDisplayStatus(),
          })
          return
        }
      }
      const configured = await configureDisplay()

      broadcastSse({
        type: "status",
        status: currentStatus(),
      })

      sendJson(res, configured.success ? 200 : 409, {
        ...configured,
        profile: getDisplayProfile(),
        ...support,
      })
      return
    } catch (error) {
      sendJson(res, 400, {
        success: false,
        error: error instanceof Error ? error.message : "Bad request",
        profile: getDisplayProfile(),
        ...getDisplaySupportSnapshot(),
        status: getDisplayStatus(),
      })
      return
    }
  }

  if (method === "POST" && (url === "/display/mode/add" || url === "/display/mode/remove")) {
    try {
      const payload = /** @type {any} */ (await readJson(req))
      if (payload?.profile) {
        updateDisplayProfile(payload.profile)
      }
      const action = url === "/display/mode/add" ? "add" : "remove"
      const modeSupport = getModeCommandSupport(action)
      const support = getDisplaySupportSnapshot()

      if (!modeSupport.supported) {
        setDisplayState({
          lastError: modeSupport.reason,
          lastOutput: modeSupport.reason,
        })
        broadcastSse({
          type: "status",
          status: currentStatus(),
        })
        sendJson(res, 409, {
          success: false,
          error: modeSupport.reason,
          applied: false,
          action,
          profile: getDisplayProfile(),
          ...support,
          status: getDisplayStatus(),
        })
        return
      }

      if (DISPLAY_PROVIDER === "custom-cli" && !displayState.active) {
        const prepared = await ensureDisplay("extend", { skipConfigure: true })
        if (!prepared.success) {
          broadcastSse({
            type: "status",
            status: currentStatus(),
          })
          sendJson(res, 409, {
            success: false,
            error: prepared.error || `Failed to prepare display before ${action} mode`,
            applied: false,
            action,
            profile: getDisplayProfile(),
            ...support,
            prepare: prepared,
            status: getDisplayStatus(),
          })
          return
        }
      }

      const modeResult = await applyDisplayModeCommand(action)
      const probeResult = await probeDisplay()
      if (!probeResult.success && modeResult.success) {
        setDisplayState({
          lastError: null,
          lastOutput:
            `${modeResult.status.lastOutput || `Display mode ${action} command applied`} | Probe warning: ${probeResult.error || "unknown"}`,
        })
      }

      broadcastSse({
        type: "status",
        status: currentStatus(),
      })

      sendJson(res, modeResult.success ? 200 : 409, {
        ...modeResult,
        action,
        probe: probeResult,
        profile: getDisplayProfile(),
        ...support,
      })
      return
    } catch (error) {
      sendJson(res, 400, {
        success: false,
        error: error instanceof Error ? error.message : "Bad request",
        profile: getDisplayProfile(),
        ...getDisplaySupportSnapshot(),
        status: getDisplayStatus(),
      })
      return
    }
  }

  if (method === "POST" && url === "/display/ensure") {
    try {
      const payload = /** @type {any} */ (await readJson(req))
      const mode = payload?.mode === "extend" ? "extend" : "extend"
      const ensured = await ensureDisplay(mode)
      broadcastSse({
        type: "status",
        status: currentStatus(),
      })
      sendJson(res, ensured.success ? 200 : 409, ensured)
      return
    } catch (error) {
      sendJson(res, 400, {
        success: false,
        error: error instanceof Error ? error.message : "Bad request",
        status: getDisplayStatus(),
      })
      return
    }
  }

  if (method === "POST" && url === "/display/release") {
    try {
      await readJson(req)
      const released = await releaseDisplay()
      broadcastSse({
        type: "status",
        status: currentStatus(),
      })
      sendJson(res, released.success ? 200 : 409, released)
      return
    } catch (error) {
      sendJson(res, 400, {
        success: false,
        error: error instanceof Error ? error.message : "Bad request",
        status: getDisplayStatus(),
      })
      return
    }
  }

  if (method === "POST" && url === "/display/probe") {
    try {
      await readJson(req)
      const probed = await probeDisplay()
      broadcastSse({
        type: "status",
        status: currentStatus(),
      })
      sendJson(res, probed.success ? 200 : 409, probed)
      return
    } catch (error) {
      sendJson(res, 400, {
        success: false,
        error: error instanceof Error ? error.message : "Bad request",
        status: getDisplayStatus(),
      })
      return
    }
  }

  if (method === "GET" && url === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    })

    writeSse(res, { type: "connected", timestamp: Date.now() })
    writeSse(res, { type: "status", status: currentStatus() })
    writeSse(res, { type: "telemetry", telemetry: currentTelemetry() })

    sseClients.add(res)
    const heartbeat = setInterval(() => {
      try {
        res.write(": heartbeat\n\n")
      } catch {
        clearInterval(heartbeat)
        sseClients.delete(res)
      }
    }, 15000)

    req.on("close", () => {
      clearInterval(heartbeat)
      sseClients.delete(res)
    })
    return
  }

  if (method === "POST" && url === "/session/start") {
    try {
      const payload = /** @type {any} */ (await readJson(req))
      if (!payload.sessionId || !payload.token || !payload.hostId) {
        sendJson(res, 400, { success: false, error: "Missing required fields" })
        return
      }
      const profile = payload.profile === "balanced" ? "balanced" : "low-latency"

      if (activeSession && activeSession.sessionId !== payload.sessionId) {
        sendJson(res, 409, {
          success: false,
          error: "Another session is already running",
          status: currentStatus(),
        })
        return
      }

      if (!activeSession) {
        activeSession = {
          sessionId: String(payload.sessionId),
          hostId: String(payload.hostId),
          token: String(payload.token),
          profile,
          startedAt: Date.now(),
        }
      }

      if (payload?.displayProfile) {
        updateDisplayProfile(payload.displayProfile)
      }

      const skipDisplayEnsure = Boolean(payload?.skipDisplayEnsure)
      let displayEnsure = null
      if (DISPLAY_AUTO_CREATE && !skipDisplayEnsure) {
        displayEnsure = await ensureDisplay("extend")
      }

      broadcastSse({
        type: "status",
        status: currentStatus(),
      })

      sendJson(res, 200, {
        success: true,
        status: currentStatus(),
        displayEnsure,
      })
      return
    } catch (error) {
      sendJson(res, 400, {
        success: false,
        error: error instanceof Error ? error.message : "Bad request",
      })
      return
    }
  }

  if (method === "POST" && url === "/session/stop") {
    try {
      const payload = /** @type {any} */ (await readJson(req))
      const requestedId = payload?.sessionId ? String(payload.sessionId) : null

      if (requestedId && activeSession && activeSession.sessionId !== requestedId) {
        sendJson(res, 409, {
          success: false,
          error: "Session ID mismatch",
          status: currentStatus(),
        })
        return
      }

      activeSession = null
      let displayRelease = null
      if (DISPLAY_AUTO_RELEASE) {
        displayRelease = await releaseDisplay()
      }
      broadcastSse({
        type: "status",
        status: currentStatus(),
      })
      sendJson(res, 200, {
        success: true,
        status: currentStatus(),
        displayRelease,
      })
      return
    } catch (error) {
      sendJson(res, 400, {
        success: false,
        error: error instanceof Error ? error.message : "Bad request",
      })
      return
    }
  }

  sendJson(res, 404, { error: "Not found" })
})

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.log(`[host-agent] Port ${PORT} already in use. Keeping current service.`)
    process.exit(0)
  }
  console.error("[host-agent] Server error:", err)
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  console.log(`[host-agent] Listening at http://${HOST}:${PORT}`)
})

const telemetryInterval = setInterval(() => {
  if (sseClients.size === 0) return
  broadcastSse({
    type: "telemetry",
    telemetry: currentTelemetry(),
  })
}, 1000)

const shutdown = () => {
  clearInterval(telemetryInterval)
  server.close(() => process.exit(0))
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
