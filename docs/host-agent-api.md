# Host Agent Local API

Base URL padrao no dashboard: `http://127.0.0.1:47831`

No frontend, as chamadas passam por proxy em:
- `GET /api/host-agent/status`
- `GET /api/host-agent/events` (SSE)
- `POST /api/host-agent/session/start`
- `POST /api/host-agent/session/stop`
- `GET /api/host-agent/display/status`
- `GET /api/host-agent/display/profile`
- `POST /api/host-agent/display/ensure`
- `POST /api/host-agent/display/release`
- `POST /api/host-agent/display/probe`
- `POST /api/host-agent/display/configure`
- `POST /api/host-agent/display/profile`

## Agent local implementado (v1)
- Script standalone: `pnpm agent:start`
- O comando `pnpm dev` inicia automaticamente o agent local (desligue com `HOST_AGENT_AUTO_START=0`).
- Variaveis suportadas:
  - `HOST_AGENT_BASE_URL` (no Next proxy, para apontar para outro host/porta)
  - `HOST_AGENT_HOST` (host de bind do agent local)
  - `HOST_AGENT_PORT` (porta de bind do agent local, padrao `47831`)
  - `HOST_AGENT_CAPTURE_MODE` (exibicao em `/status`)
  - `HOST_AGENT_API_KEY` (chave opcional para proteger chamadas locais)
  - `HOST_AGENT_DISPLAY_PROVIDER` (`windows-display-switch` | `custom-cli` | `none`)
  - `HOST_AGENT_DISPLAY_CREATE_CMD` (obrigatorio no provider `custom-cli`)
  - `HOST_AGENT_DISPLAY_RELEASE_CMD` (obrigatorio no provider `custom-cli`)
  - `HOST_AGENT_DISPLAY_STATUS_CMD` (probe/status do provider; no `windows-display-switch` default usa `where DisplaySwitch.exe`)
  - `HOST_AGENT_DISPLAY_CONFIGURE_CMD` (opcional; aplica resolucao/DPI/escala no provider `custom-cli`)
  - `HOST_AGENT_DISPLAY_AUTO_CREATE` (`1` padrao, tenta expandir display ao iniciar sessao)
  - `HOST_AGENT_DISPLAY_AUTO_RELEASE` (`0` padrao, libera display ao parar sessao)
  - `HOST_AGENT_DISPLAY_AUTO_CONFIGURE` (`1` padrao, aplica perfil antes do ensure)
  - `HOST_AGENT_DISPLAY_WIDTH` (padrao `1920`)
  - `HOST_AGENT_DISPLAY_HEIGHT` (padrao `1080`)
  - `HOST_AGENT_DISPLAY_REFRESH_HZ` (padrao `60`)
  - `HOST_AGENT_DISPLAY_DPI` (padrao `96`)
  - `HOST_AGENT_DISPLAY_SCALE_PERCENT` (padrao `100`)
  - `HOST_AGENT_DISPLAY_COLOR_DEPTH` (padrao `8`)
  - `HOST_AGENT_DISPLAY_MONITOR_ID` (padrao `2`, alvo do comando custom)
  - `HOST_AGENT_DISPLAY_ORIENTATION` (`landscape` | `portrait`; padrao `landscape`)

### Observacao sobre provider de display
- `windows-display-switch`: usa `DisplaySwitch.exe /extend` e `DisplaySwitch.exe /internal`.
  - util para colocar o Windows em modo expandido;
  - nao cria monitor virtual por si so.
  - nao altera resolucao/DPI via API sem comando externo de configure.
- `custom-cli`: usado para integrar um driver/ferramenta de monitor virtual real.
  - configure comandos de criacao/remocao no ambiente.

Exemplo (PowerShell):

```powershell
$env:HOST_AGENT_DISPLAY_PROVIDER='custom-cli'
$env:HOST_AGENT_DISPLAY_CREATE_CMD='C:\Tools\VirtualDisplay\vd-cli.exe create --count 1'
$env:HOST_AGENT_DISPLAY_RELEASE_CMD='C:\Tools\VirtualDisplay\vd-cli.exe remove --all'
$env:HOST_AGENT_DISPLAY_CONFIGURE_CMD='C:\Tools\VirtualDisplay\vd-cli.exe set --monitor {monitorId} --width {width} --height {height} --hz {refreshHz} --dpi {dpi} --scale {scalePercent}'
npx --yes pnpm@latest dev
```

Exemplo com `setresolution.exe`:

```powershell
$cli = "$env:USERPROFILE\.dotnet\tools\setresolution.exe"
$env:HOST_AGENT_DISPLAY_PROVIDER='custom-cli'
$env:HOST_AGENT_DISPLAY_CREATE_CMD='DisplaySwitch.exe /extend'
$env:HOST_AGENT_DISPLAY_CONFIGURE_CMD="`"$cli`" SET -m{monitorId} -w {width} -h {height} -f {refreshHz} -b 32 -noprompt"
$env:HOST_AGENT_DISPLAY_RELEASE_CMD='DisplaySwitch.exe /internal'
$env:HOST_AGENT_DISPLAY_STATUS_CMD="`"$cli`" LIST -la"
npx --yes pnpm@latest dev
```

Observacao: no `setresolution`, prefira `LIST -la` no status. O agent faz preflight interno por monitor e evita aplicar `SET` quando o monitor/modo nao existe.

Placeholders aceitos em comandos custom:
- `{sessionId}`
- `{hostId}`
- `{profile}`
- `{width}`
- `{height}`
- `{refreshHz}`
- `{dpi}`
- `{scalePercent}`
- `{colorDepth}`
- `{monitorId}`
- `{orientation}`

## Autenticacao local (recomendada)
- Quando `HOST_AGENT_API_KEY` estiver configurada no agent, ele exige header:
  - `x-host-agent-key: <API_KEY>`
- O proxy do Next envia esse header automaticamente se a variavel `HOST_AGENT_API_KEY` estiver setada no app.
- No `pnpm dev`, uma chave aleatoria e gerada e compartilhada automaticamente entre proxy e agent local.

## GET /status
Resposta:

```json
{
  "running": true,
  "version": "0.1.0",
  "captureMode": "desktop-capture",
  "uptimeMs": 12040,
  "pid": 12345,
  "sessionId": "abc123",
  "profile": "low-latency",
  "startedAt": 1737510000000,
  "authRequired": true,
  "display": {
    "provider": "windows-display-switch",
    "available": true,
    "active": true,
    "mode": "extend",
    "profile": {
      "width": 1920,
      "height": 1080,
      "refreshHz": 60,
      "dpi": 96,
      "scalePercent": 100,
      "colorDepth": 8,
      "monitorId": 2,
      "orientation": "landscape"
    },
    "lastError": null,
    "lastActionAt": 1737510000000,
    "lastOutput": null
  }
}
```

Se `applyNow=true` e o provider nao suportar configuracao (ex.: `windows-display-switch`), retorna `409` com `error`, `configureSupported=false` e `configureReason`.

## GET /events (SSE)
Headers:
- `Content-Type: text/event-stream`

Eventos enviados no campo `data` (JSON):

```json
{ "type": "connected", "timestamp": 1737510000000 }
```

```json
{
  "type": "status",
  "status": {
    "running": true,
    "version": "0.1.0",
    "captureMode": "desktop-capture",
    "display": {
      "active": true
    }
  }
}
```

```json
{
  "type": "telemetry",
  "telemetry": {
    "timestamp": 1737510001200,
    "uptimeMs": 1200,
    "sessionRunning": true,
    "displayActive": true,
    "rssBytes": 51200000,
    "heapUsedBytes": 18500000
  }
}
```

## Display endpoints

### GET /display/status
Resposta:

```json
{
  "provider": "windows-display-switch",
  "available": true,
  "active": false,
  "mode": "unknown",
  "profile": {
    "width": 1920,
    "height": 1080,
    "refreshHz": 60,
    "dpi": 96,
    "scalePercent": 100,
    "colorDepth": 8,
    "monitorId": 2,
    "orientation": "landscape"
  },
  "lastError": null,
  "lastActionAt": null,
  "lastOutput": null,
  "detectedMonitorIds": [1, 2],
  "detectedModes": [
    { "width": 1920, "height": 1080, "hz": 60, "bitDepth": 32, "current": true }
  ],
  "targetMonitorFound": true
}
```

### GET /display/profile
Resposta:

```json
{
  "success": true,
  "configureSupported": false,
  "configureReason": "windows-display-switch does not apply resolution/DPI. Use custom-cli + HOST_AGENT_DISPLAY_CONFIGURE_CMD.",
  "profile": {
    "width": 1920,
    "height": 1080,
    "refreshHz": 60,
    "dpi": 96,
    "scalePercent": 100,
    "colorDepth": 8,
    "monitorId": 2,
    "orientation": "landscape"
  },
  "capabilities": {
    "width": { "min": 640, "max": 7680 },
    "height": { "min": 360, "max": 4320 },
    "refreshHz": { "min": 24, "max": 240 },
    "dpi": { "min": 72, "max": 400 },
    "scalePercent": { "min": 50, "max": 300 },
    "colorDepth": { "min": 6, "max": 16 },
    "monitorId": { "min": 1, "max": 16 },
    "orientation": ["landscape", "portrait"]
  }
}
```

### POST /display/profile
Payload:

```json
{
  "profile": {
    "width": 2560,
    "height": 1440,
    "refreshHz": 60,
    "dpi": 109,
    "scalePercent": 100,
    "colorDepth": 8,
    "monitorId": 2,
    "orientation": "landscape"
  },
  "applyNow": false
}
```

Resposta:

```json
{
  "success": true,
  "profile": {
    "width": 2560,
    "height": 1440,
    "refreshHz": 60,
    "dpi": 109,
    "scalePercent": 100,
    "colorDepth": 8,
    "monitorId": 2,
    "orientation": "landscape"
  },
  "configure": null
}
```

### POST /display/configure
Payload:

```json
{
  "profile": {
    "width": 2560,
    "height": 1440,
    "refreshHz": 60,
    "dpi": 109,
    "scalePercent": 100,
    "monitorId": 2,
    "orientation": "landscape"
  }
}
```

Resposta:

```json
{
  "success": true,
  "applied": true,
  "status": {
    "available": true,
    "lastOutput": "..."
  },
  "profile": {
    "width": 2560,
    "height": 1440,
    "refreshHz": 60,
    "dpi": 109,
    "scalePercent": 100,
    "colorDepth": 8,
    "monitorId": 2,
    "orientation": "landscape"
  }
}
```

### POST /display/ensure
Payload:

```json
{
  "mode": "extend"
}
```

Resposta:

```json
{
  "success": true,
  "status": {
    "active": true,
    "mode": "extend"
  }
}
```

### POST /display/release
Payload:

```json
{}
```

Resposta:

```json
{
  "success": true,
  "status": {
    "active": false,
    "mode": "unknown"
  }
}
```

### POST /display/probe
Payload:

```json
{}
```

Resposta:

```json
{
  "success": true,
  "status": {
    "available": true,
    "lastOutput": "..."
  }
}
```

Campos:
- `running`: indica se o pipeline de captura/encode esta ativo.
- `version`: versao do agente.
- `captureMode`: `"virtual-display"` | `"desktop-capture"` | `"unknown"`.

## POST /session/start
Payload:

```json
{
  "sessionId": "abc123",
  "token": "hex-token",
  "hostId": "host-01",
  "profile": "low-latency",
  "displayProfile": {
    "width": 1920,
    "height": 1080,
    "refreshHz": 60,
    "dpi": 96,
    "scalePercent": 100,
    "colorDepth": 8,
    "monitorId": 2,
    "orientation": "landscape"
  },
  "skipDisplayEnsure": true
}
```

`skipDisplayEnsure=true` evita reexecutar `ensure/configure` no `session/start` quando o display ja foi preparado antes da captura.

Resposta esperada:

```json
{
  "success": true,
  "displayEnsure": {
    "success": true
  },
  "status": {
    "running": true
  }
}
```

## POST /session/stop
Payload:

```json
{
  "sessionId": "abc123"
}
```

Resposta esperada:

```json
{
  "success": true,
  "status": {
    "running": false
  }
}
```
