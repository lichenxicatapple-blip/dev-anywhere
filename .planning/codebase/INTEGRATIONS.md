# External Integrations

**Analysis Date:** 2026-04-20

CC Anywhere has a small and deliberate integration surface: it shells out to one CLI (`claude`), ships its own relay WebSocket protocol, and serves PWA static assets + fonts. No third-party APIs, no databases, no auth provider — the only auth is a self-issued pre-shared token.

## APIs & External Services

**None.** This codebase does not call any third-party HTTP/REST/GraphQL API. No Stripe, OpenAI/Anthropic HTTP, AWS SDK, Supabase, Firebase, GitHub API, Feishu API, etc. All "AI" capability is delegated to the local `claude` CLI.

**Font delivery (self-hosted):**
- Sarasa Fixed SC web fonts served by the relay's `/fonts/*` static endpoint.
- Files live on the relay host at `~/.cc-anywhere/relay-data/fonts/` (or `DATA_DIR/fonts` when `DATA_DIR` is overridden). See `apps/relay/src/server.ts` L37-45.
- Web SPA loads `/fonts/sarasa-fixed-sc/result.css` at boot via `loadFontCSS()` in `apps/web/src/hooks/use-relay-setup.ts` L20-29.
- Caching: nginx `Cache-Control` via service worker runtime cache `CacheFirst` with `maxAgeSeconds: 180 days` (`apps/web/vite.config.ts` L51-60).

## CLIs / Child Processes (Shell-out Integrations)

This is the primary integration pattern. Everything interesting is a spawned process.

### `claude` CLI (Anthropic Claude Code)

The entire product is a wrapper around the `claude` binary. Two distinct invocation modes.

**Mode 1 — PTY transparent wrap (local terminal UX):**
- File: `apps/proxy/src/pty-manager.ts` L43-101
- Resolution: `CLAUDE_BIN` env var, else `which claude` via `execFileSync` (L6-14). Throws if neither available.
- Spawn: `pty.spawn(claudePath, claudeArgs, { name: TERM, cols, rows, cwd: INIT_CWD || process.cwd(), env: process.env })`.
- All stdin/stdout flows through a Microsoft `node-pty` PTY; output is also captured by a `@xterm/headless` emulator to produce `session_snapshot` frames for late-joining clients.

**Mode 2 — stream-json programmatic (remote control):**
- File: `apps/proxy/src/json-session.ts` L111-310
- Spawned via `child_process.spawn(claudeBin, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: filteredEnv })` (L154-158).
- Built arguments (L91-109, L138-150):
  ```
  claude --output-format stream-json --input-format stream-json \
         --permission-prompt-tool stdio \
         --permission-mode <default|auto|acceptEdits|plan|bypassPermissions|dontAsk> \
         --verbose \
         --fork-session \
         [--resume <claude-session-id>] \
         [<extra claude args>]
  ```
- The `CLAUDECODE*` environment variables are stripped before spawn (`json-session.ts` L80-88 `filterClaudeEnvVars`) to avoid leaking wrapper state into the child.
- Stdout parsed as newline-delimited JSON events (`LineBuffer` in `apps/proxy/src/line-buffer.ts`). Typed variants: `system`, `assistant`, `user`, `result`, `control_request`, `control_cancel_request`, `stream_event`.
- Permission prompts arrive as `control_request` with `subtype: "can_use_tool"`; proxy replies on stdin with `control_response` JSON (L252-291). Default policy denies all; a configured `ApprovalStrategy` forwards to the relay and awaits the user's `tool_approve` / `tool_deny` envelope.

### Subordinate helper CLIs (spawned by proxy/serve)

- `scutil --get ComputerName` (macOS only) — auto-detect proxy display name (`apps/proxy/src/serve.ts` L780-786). Falls back to `hostname()` on failure.
- `which claude` — resolve claude binary (`apps/proxy/src/pty-manager.ts` L10).

### Daemon self-spawning

Not third-party, but worth documenting: the proxy CLI daemonizes by `spawn(tsx|process.execPath, [servePath], { detached: true, stdio: "ignore" })` and similarly for `session-worker.ts` per session (`apps/proxy/src/serve.ts` L350-370). Dev vs. prod is distinguished by `__filename.endsWith(".ts")`.

### Deployment scripts

- `apps/relay/deploy.sh` shells out to `ssh`, `scp`, `tar`, `docker`, `docker compose`, `certbot`, `curl`, `openssl rand -hex 24`, `apt-get`/`dnf`/`yum`, `systemctl`.
- `scripts/install-relay.sh` runs on the VPS: `docker`, `docker compose`, `certbot`, `openssl`.

## Data Storage

**Databases:** None. No SQL, no NoSQL, no key-value store. No ORM. No migrations directory.

**Relay server state (in-memory only):**
- `RelayRegistry` in `apps/relay/src/registry.ts` is a pure in-memory `Map`. Restarting the relay loses all proxy/client bindings — intentional per `apps/relay/src/router.ts` L75-102: `handleReplayRequest` always returns `gap_unrecoverable`, "relay is stateless, no buffer".

**Proxy local persistence (filesystem):**
| Path | Purpose | Writer |
|------|---------|--------|
| `~/.cc-anywhere/config.json` | `relayUrl`, `relayToken` | CLI `init`, hand-editable |
| `~/.cc-anywhere/proxy-id` | persistent `proxyId` (nanoid 21) | `apps/proxy/src/relay-connection.ts` L70-85 |
| `~/.cc-anywhere/run/cc-anywhere.{sock,pid}` | daemon socket + PID | `apps/proxy/src/serve.ts` L1145-1148 |
| `~/.cc-anywhere/run/stopped` | clean-shutdown marker | `apps/proxy/src/index.ts` stopService |
| `~/.cc-anywhere/state/sessions.json` | persistent session metadata | `SessionManager` (`apps/proxy/src/session-manager.ts`) |
| `~/.cc-anywhere/data/<sessionId>/events.bin` | binary event log per session | session worker |
| `~/.cc-anywhere/data/<sessionId>/worker.sock` | JSON-worker IPC socket | session-worker |
| `~/.cc-anywhere/logs/service.log` | pino file log | `packages/shared/src/logger.ts` L31-34 |

**Relay container volume:**
- Named volume `relay-data` → `/data` inside container (`apps/relay/docker-compose.yml` L14-15).
- Holds `fonts/` subdirectory synced from operator's local `~/.cc-anywhere/relay-data/fonts/` by `deploy.sh` Step 5.

**Claude CLI-managed history (read-only consumer):**
- Proxy reads `~/.claude/projects/<encoded-project-path>/<session-id>.jsonl` to surface past Claude sessions (`apps/proxy/src/session-history.ts` L17, L79). Writer is the claude CLI itself; proxy only reads/scans for history listing and resume.
- Proxy also scans `~/.claude/skills/`, `~/.claude/commands/`, `~/.claude/plugins/cache/*/{skills,commands}/` for slash-command discovery (`apps/proxy/src/command-discovery.ts` L138-196). Read-only.

**File Storage:** No S3 / Azure Blob / GCS / Cloudflare R2. Fonts are the only "blob" data and are synced over SSH/scp during deploy.

**Caching:** None server-side. Client has Workbox runtime cache for fonts only (`apps/web/vite.config.ts` L51-60).

## Authentication & Identity

**No external auth provider.** No OAuth, no Auth0, no Clerk, no Supabase auth. No user model at all.

**Relay proxy-endpoint auth (pre-shared token):**
- File: `apps/relay/src/server.ts` L59-68
- Mechanism: `WS /proxy?token=<token>` query-string. If server has `RELAY_PROXY_TOKEN` env set, request is rejected with `HTTP 401 Unauthorized` when the token does not match.
- Token generation: `openssl rand -hex 24` in `deploy.sh` L33 and `install-relay.sh` L155.
- Token storage: server side in `/opt/cc-anywhere/.env` (`chmod 600`); client side in `~/.cc-anywhere/config.json` under `relayToken`.
- Known limitation: logged explicitly by relay when unset — `"proxy auth token not set, /proxy endpoint is open — ok for dev, not for public relay"` (`server.ts` L31).

**Relay client-endpoint auth:**
- `WS /client` is **unauthenticated** (`server.ts` L75-80). Anyone who can reach the relay can connect as a client, list proxies, and (after `proxy_select`) drive any proxy.
- Client identity is a self-generated nanoid stored in app state (`apps/web/src/stores/app-store.ts`). No verification.
- This is by design for a self-hosted tool, but it means: **the only real security boundary is the pre-shared proxy token**. A client who knows the relay URL and picks a proxy ID can interact with that proxy without further auth.

**No JWT. No sessions. No cookies.** Everything is stateless at the relay layer.

## Monitoring & Observability

**Error Tracking:**
- None. No Sentry, no Bugsnag, no Rollbar. Errors go to pino logs.

**Logs:**
- Library: `pino` `^10.3.1` (`packages/shared/src/logger.ts`).
- Shape: JSON, multistream (file + optional stdout). Proxy daemon writes to `~/.cc-anywhere/logs/service.log`; relay writes to stdout with `stdout: true`.
- Default level `info`, overridable via `LOG_LEVEL`.
- No log shipping / aggregation.

**Metrics:**
- None. No Prometheus, no statsd, no OTEL.

**Health checks:**
- Relay `GET /health` → `{status, uptime}` (`apps/relay/src/health.ts` L8-13).
- Relay `GET /status` → `{proxyCount, clientCount, uptime}` (L15-21).
- Relay `GET /api/status` → adds `bindings` (client→proxy mapping) (L24-31).
- Relay `GET /api/proxies` → per-proxy details (L34-40).
- Relay `GET /api/clients` → per-client details (L43-45).
- Docker healthcheck: `wget -qO- http://localhost:3100/health` every 30s (`apps/relay/Dockerfile` L38-39, `docker-compose.yml` L19-22).

## CI/CD & Deployment

**Hosting:**
- Relay: self-hosted Docker container on any VPS (docker compose stack with `nginx` + `relay`).
- Nginx-baked Web SPA: built from `apps/web/dist` into the `cc-anywhere-web` image.

**TLS:**
- Let's Encrypt via `certbot certonly --standalone -d <domain> --cert-name relay`. Cert path hardcoded as `/etc/letsencrypt/live/relay/{fullchain.pem, privkey.pem}` in `apps/relay/nginx.conf` L22-23.
- Renewal: operator's cron (not managed by this repo).

**Container registries:**
- Primary: GitHub Container Registry (GHCR) at `ghcr.io/<owner>/cc-anywhere-{relay,web}`.
- Optional mirror: Aliyun ACR via `REGISTRY_BASE` env (e.g. `registry.cn-hangzhou.aliyuncs.com/<namespace>`) for China-region VPS pull speed. Enabled in CI when `ACR_REGISTRY`, `ACR_USERNAME`, `ACR_PASSWORD`, `ACR_NAMESPACE` secrets all set (`.github/workflows/release.yml` L36-43, L51-57).

**npm registry:**
- Publishes `@lichenxi.cat/cc-anywhere` (proxy) and `@lichenxi.cat/cc-anywhere-relay` (relay server) to npmjs.org via `NPM_TOKEN` secret.
- `@cc-anywhere/shared` and `@cc-anywhere/web` are `private: true` — not published.

**CI Pipeline:**
- GitHub Actions `.github/workflows/release.yml`, triggered on tag `v*.*.*` or manual dispatch.
- Actions used: `actions/checkout@v4`, `docker/setup-buildx-action@v3`, `docker/login-action@v3`, `docker/metadata-action@v5`, `docker/build-push-action@v6`, `pnpm/action-setup@v4`, `actions/setup-node@v4`.
- Cache: GitHub Actions cache (`type=gha`) for Docker layers.

**Deployment scripts:**
- `apps/relay/deploy.sh` — source-build deploy (builds locally on VPS via docker compose).
- `scripts/install-relay.sh` — pre-built image deploy from GHCR/ACR (supports `--ssh <host>` remote bootstrap and direct on-VPS run).

## Environment Configuration

**Proxy (required on client machine):**
| Var | Required | Notes |
|-----|----------|-------|
| `RELAY_URL` | one of env/config | e.g. `wss://relay.example.com`. |
| `RELAY_PROXY_TOKEN` | if relay enforces auth | Must match server. |
| `CLAUDE_BIN` | optional | Overrides `which claude`. |
| `CC_ANYWHERE_PROXY_NAME` | optional | Display name shown in the web picker. |
| `INIT_CWD` | forwarded by pnpm scripts | Session working dir. |

**Relay (required on server):**
| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | `3100` | HTTP+WS listen port. |
| `RELAY_PROXY_TOKEN` | unset | **Must be set in production.** |
| `DATA_DIR` | `~/.cc-anywhere/relay-data` | Empty string disables. |
| `HEARTBEAT_INTERVAL` | `30000` | ms between WS pings. |
| `LOG_LEVEL` | `info` | pino level. |

**CI (GitHub Actions secrets):**
| Secret | Purpose |
|--------|---------|
| `GITHUB_TOKEN` | GHCR push (auto-provided). |
| `NPM_TOKEN` | npm publish. |
| `ACR_REGISTRY`, `ACR_NAMESPACE`, `ACR_USERNAME`, `ACR_PASSWORD` | optional Aliyun ACR mirror push. |

**Secrets location on VPS:**
- `/opt/cc-anywhere/.env` (chmod 600) — contains `RELAY_PROXY_TOKEN` and other relay env. Generated by `install-relay.sh` or `deploy.sh`.

## Webhooks & Callbacks

**Incoming HTTP webhooks:** None.
**Outgoing HTTP webhooks:** None.
**Slack/Discord/etc. integrations:** None.

## WebSocket Protocol (Core Integration Surface)

The relay is a WebSocket bridge; its protocol is the product's core I/O surface.

**Endpoints (single port, path-routed):**
| Path | Direction | Auth | Purpose |
|------|-----------|------|---------|
| `WS /proxy` | proxy → relay | pre-shared token (query `?token=`) | Local proxy daemon registers; bidirectional message stream. |
| `WS /client` | browser → relay | open | Web SPA / PWA clients; bidirectional. |
| `HTTP GET /health` | any | open | Liveness. |
| `HTTP GET /status` | any | open | Proxy/client counts. |
| `HTTP GET /api/status` | any | open | Detailed status. |
| `HTTP GET /api/proxies` | any | open | Per-proxy detail. |
| `HTTP GET /api/clients` | any | open | Per-client detail. |
| `HTTP GET /fonts/*` | any | open | Static font files. |

**Framing:**
- `text` frames: JSON serialized with `JSON.stringify`. Two schema layers:
  1. **MessageEnvelope** (`packages/shared/src/schemas/envelope.ts` L39-129) — discriminated union by `type`, 18 variants (user_input, assistant_message, thinking, tool_use_request, tool_approve, tool_deny, tool_result, session_create, session_list, session_switch, session_terminate, session_status, heartbeat, error, auth, sync_request, sync_response). Shape: `{seq, sessionId, timestamp, source: "proxy"|"client", version, type, payload}`. Per-session monotonic `seq` (not relay-scoped).
  2. **RelayControl** (`packages/shared/src/schemas/relay-control.ts` L30-280) — discriminated union by `type`, ~40 variants covering: proxy registration (`proxy_register`, `proxy_register_response`), proxy listing/selection (`proxy_list_request`, `proxy_select`), replay (`replay_request`, `replay_response`, `gap_unrecoverable`), lifecycle (`proxy_offline`, `proxy_online`, `proxy_disconnect`), directory/file tree (`dir_list_request`, `dir_create_request`, `file_tree_push`), command discovery (`command_list_push`), session CRUD (`session_create`, `session_terminate`, `session_worker_abort`, `session_history_request`, `session_messages_request`, `session_resources_request`), PTY snapshots (`session_subscribe`, `session_snapshot`, `terminal_title`, `terminal_resize`, `pty_state`), raw PTY input (`remote_input_raw`), approvals (`pending_approvals_push`), history (`session_history_messages`), and `permission_mode_change`.
- `binary` frames: **ArrayBuffer-framed PTY data**. Format: `[1 byte sessionId-len][sessionId UTF-8 bytes][raw PTY output]`. Encoded by `apps/proxy/src/serve.ts` L693-700; decoded client-side by `apps/web/src/services/websocket.ts` L126-136 `dispatchBinary`. Binary frames are **not** enqueued during reconnection — they are discarded (`apps/proxy/src/relay-connection.ts` L183-188), matching their live-stream semantics.
- Routing discipline: `parseMessage` in `apps/relay/src/router.ts` L18-37 tries `RelayControlSchema` first, then `MessageEnvelopeSchema`, then rejects. Relay is a dumb router: it maintains proxy↔client bindings but does not buffer/persist messages.

**Heartbeat:**
- `setupHeartbeat` (`apps/relay/src/heartbeat.ts`, referenced from `server.ts` L93-94) sends WS ping at `HEARTBEAT_INTERVAL` (default 30s) on both WSS instances.

**Reconnection:**
- Proxy side: indexed exponential backoff with jitter, base 1s, cap 30s, 10k-message in-memory queue, binary frames dropped (`apps/proxy/src/relay-connection.ts` L17-22, L164-174, L177-204).
- Client side: exponential backoff base 1s, cap 30s, text-message pending queue (`apps/web/src/services/websocket.ts` L117-124, L13, L36-42).

**IPC (not WebSocket, but protocol-adjacent):**
- Proxy daemon ↔ terminal wrapper: Unix domain socket at `~/.cc-anywhere/run/cc-anywhere.sock`. Framed protocol in `apps/proxy/src/ipc-protocol.ts` (text JSON + a binary `pty_data` sub-frame for stdout streaming).
- Proxy daemon ↔ session worker: Unix domain socket per session at `~/.cc-anywhere/data/<sessionId>/worker.sock`. Separate framed protocol `WorkerMessage` (also `ipc-protocol.ts`).

## Browser / PWA Surface

**Service Worker:** Workbox-generated via `vite-plugin-pwa`. `registerType: "autoUpdate"`. Navigate-fallback denylist excludes `/proxy`, `/client`, `/fonts`, `/health`, `/status`, `/api/*` so SW never intercepts WS handshakes or API calls (`apps/web/vite.config.ts` L41-50).

**PWA manifest:** `id: "/"`, `display: "standalone"`, `theme_color: "#1E1E1E"`, categories `["developer", "productivity"]`, `lang: "zh-CN"` (L14-38).

**Runtime caches:** Fonts only (`CacheFirst`, 40 entries, 180 days) (L51-60).

**Device APIs used:** `document.visibilityState` (auto-reconnect on tab focus, `apps/web/src/hooks/use-relay-setup.ts` L85-93), `document.fonts.ready` (xterm init, `apps/web/src/lib/create-xterm.ts` L20), WebGL context (xterm webgl renderer).

---

*Integration audit: 2026-04-20*
