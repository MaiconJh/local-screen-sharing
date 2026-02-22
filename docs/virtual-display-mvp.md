# Virtual Display MVP (Low Latency)

## Objetivo
Reduzir latencia alem do limite do `getDisplayMedia`, evoluindo para um host nativo que cria um display virtual, captura via GPU, comprime por hardware e envia em tempo real.

## Limite atual do browser
- O app web captura o desktop renderizado pelo compositor.
- Nao existe API web para criar "monitor virtual" real.
- Para virar "display simulado", precisa de processo nativo no host.

## Arquitetura proposta

### 1) Host Agent (Windows nativo)
- Runtime: Rust ou C++.
- Display virtual: Indirect Display Driver (IDD) / monitor virtual.
- Captura: Desktop Duplication API (DXGI) do display virtual.
- Encoder: NVENC (NVIDIA), AMF (AMD), QuickSync (Intel).
- Transporte: WebRTC nativo (preferencial) com perfil ultra-low-latency.
- Controle remoto: canal de dados separado (input).

Status atual do repositorio:
- Existe um host-agent local v1 (Node) para controle de sessao e healthcheck.
- Endpoints prontos: `/status`, `/session/start`, `/session/stop` (via proxy Next em `/api/host-agent/*`).
- Controle de display pronto: `/display/status`, `/display/profile`, `/display/configure`, `/display/ensure`, `/display/release`.
- Diagnostico de provider pronto: `/display/probe` com output e erros.
- Providers atuais: `windows-display-switch` (expandir) e `custom-cli` (integracao com driver virtual externo).
- Dashboard host ja permite definir perfil pre-stream (resolucao, refresh, DPI, escala, orientacao e color depth) antes da virtualizacao.
- Ainda nao realiza captura/encode nativos; essa parte entra na fase de agent nativo (Rust/C++).

### 2) Signaling Server (reuso parcial do app atual)
- Mantem SDP/ICE exchange.
- Mantem sessao, token e papeis (`controller`/`viewer`).
- Roteamento host-agent <-> clientes.

### 3) Cliente Web
- Continua em Next.js/WebRTC.
- Recebe stream do host agent.
- Controller envia input por DataChannel.

## Fluxo de sessao
1. Host abre dashboard web e inicia sessao.
2. Dashboard chama host-agent local (localhost API).
3. Host-agent cria display virtual e inicia pipeline de captura/encode.
4. Cliente entra por token/QR.
5. Signaling negocia WebRTC com host-agent (nao com aba do browser host).
6. Video/audio/control seguem por canais separados.

## Perfil tecnico recomendado (MVP LAN)
- Codec: H.264 Baseline/Main.
- GOP curto: 0.5s a 1.0s.
- Sem B-frames (menor latencia).
- Controller stream: 720p60 com prioridade de input.
- Viewer stream: 1080p30/60 adaptativo.
- Bitrate adaptativo por RTT/jitter/loss (ja iniciado no host-dashboard atual).

## Seguranca
- Token de sessao de curta duracao.
- TLS no signaling.
- Whitelist de subrede LAN opcional.
- Controle remoto bloqueavel por host.
- Audit log de conexao/comandos.

## Roadmap sugerido

### Fase 1 (curta)
- Reusar sinalizacao atual.
- Criar host-agent local com endpoint:
  - `POST /agent/session/start`
  - `POST /agent/session/stop`
  - `GET /agent/status`
- Trocar origem da oferta do host browser para host-agent.

### Fase 2
- Inserir driver de display virtual.
- Captura exclusiva do display virtual.
- Encoder HW + tune low-latency.

### Fase 3
- Multiprofiles por role (`controller`/`viewer`).
- Telemetria completa no dashboard (encode time, dropped frames, BWE).
- Reconexao e ICE restart automatizados no agent.

## Integracao com o codigo atual
- `app/api/session` e `app/api/signal` podem ser mantidos como controle de sessao.
- `components/host/host-dashboard.tsx` vira orquestrador (start/stop/status) em vez de capturar midia diretamente.
- `components/client/client-app.tsx` permanece como consumidor WebRTC.
