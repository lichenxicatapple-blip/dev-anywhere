# Codebase Structure

**Analysis Date:** 2026-04-20

## Directory Layout

```
cc_anywhere/
├── apps/
│   ├── proxy/                       # @lichenxi.cat/cc-anywhere — local CLI + daemon
│   │   ├── src/
│   │   │   ├── index.ts             # commander CLI entry (bin)
│   │   │   ├── terminal.ts          # PTY wrapper process (user-facing Claude Code runner)
│   │   │   ├── serve.ts             # singleton IPC daemon, talks to relay
│   │   │   ├── session-worker.ts    # child process for JSON-mode sessions
│   │   │   ├── json-session.ts      # claude --stream-json spawning + parsing
│   │   │   ├── pty-manager.ts       # node-pty lifecycle
│   │   │   ├── session-manager.ts   # in-mem SessionInfo + JSON persist + state machine
│   │   │   ├── relay-connection.ts  # outbound WS to relay, queue + backoff
│   │   │   ├── ipc-protocol.ts      # zod IpcMessage + WorkerMessage schemas + codec
│   │   │   ├── paths.ts             # ~/.cc-anywhere/* path centralization
│   │   │   ├── config.ts            # config.json loader
│   │   │   ├── osc-extractor.ts     # OSC 0/9 signal parsing from PTY stream
│   │   │   ├── command-discovery.ts # walks ~/.claude/commands and project .claude/
│   │   │   ├── session-history.ts   # reads ~/.claude/projects/*/jsonl
│   │   │   ├── dir-lister.ts        # file picker backend
│   │   │   ├── file-watcher.ts      # fs.watch abstraction
│   │   │   ├── line-buffer.ts       # stream → line splitter
│   │   │   ├── message-queue.ts     # MemoryMessageQueue for offline relay
│   │   │   ├── seq-counter.ts       # per-session monotonic seq
│   │   │   ├── logger.ts            # pino instances
│   │   │   ├── tap.ts               # DataTap type
│   │   │   └── handlers/
│   │   │       └── control-messages.ts  # dir_list / command_list / file_tree / history
│   │   ├── __tests__/unit, integration, fixtures
│   │   ├── tsup.config.ts
│   │   └── package.json
│   │
│   ├── relay/                       # @lichenxi.cat/cc-anywhere-relay
│   │   ├── src/
│   │   │   ├── index.ts             # env-driven bootstrap, listen(PORT)
│   │   │   ├── server.ts            # createRelayServer: express + 2x WebSocketServer
│   │   │   ├── router.ts            # parseMessage + routeProxyMessage / routeClientMessage
│   │   │   ├── registry.ts          # RelayRegistry (sole state)
│   │   │   ├── health.ts            # /health, /status routes
│   │   │   ├── heartbeat.ts         # WS ping + isAlive
│   │   │   └── handlers/
│   │   │       ├── proxy.ts         # /proxy WS — binary passthrough + allowlist forwarding
│   │   │       └── client.ts        # /client WS — register/select/bind + route
│   │   ├── scripts/
│   │   │   └── verify-relay.ts      # deploy smoke test
│   │   ├── deploy.sh                # SSH-based one-shot deployment
│   │   ├── setup-ssh.sh
│   │   ├── docker-compose.yml       # relay + nginx services
│   │   ├── Dockerfile
│   │   ├── nginx.conf               # path routing: /proxy /client → WS, /fonts /health → HTTP, else → SPA
│   │   ├── tsup.config.ts
│   │   └── package.json
│   │
│   └── web/                         # @cc-anywhere/web — React 19 SPA/PWA
│       ├── src/
│       │   ├── main.tsx             # root createRoot
│       │   ├── app.tsx              # App = useRelaySetup + RouterProvider
│       │   ├── app.css              # Tailwind entry + app-level vars
│       │   ├── test-hooks.ts        # e2e window globals
│       │   ├── pages/
│       │   │   ├── proxy-select.tsx
│       │   │   ├── session-list.tsx
│       │   │   ├── chat.tsx         # dispatches to ChatPtyView or ChatJsonView by ?mode=
│       │   │   ├── pty-test.tsx     # debug page for xterm
│       │   │   ├── token-showcase.tsx
│       │   │   └── markdown-test.tsx
│       │   ├── components/
│       │   │   ├── shell/           # AppShell, Sidebar, EmptyState (master-detail chrome)
│       │   │   ├── chat/            # InputBar, MessageBubble, ChatPtyView, ChatJsonView, StatusLine, ToolApprovalCard, SlashCommandPicker, FilePathPicker, QuotePreviewBar
│       │   │   ├── session/         # SessionList, SessionRow, CreateSessionDialog, HistoryList, HistoryRow
│       │   │   ├── proxy/           # ProxySwitcher, ProxyStatusDot
│       │   │   ├── brand/           # BrandHero, Typewriter
│       │   │   ├── ui/              # shadcn/ui primitives (button, dialog, popover, etc.)
│       │   │   └── toast.tsx        # Sonner integration
│       │   ├── stores/              # zustand
│       │   │   ├── app-store.ts     # phase / connected / selectedProxyId / clientId
│       │   │   ├── session-store.ts # sessions[], historySessions[], ptyTitles
│       │   │   ├── chat-store.ts    # bySessionId → messages, approvals, drafts
│       │   │   ├── command-store.ts
│       │   │   └── file-store.ts
│       │   ├── services/
│       │   │   ├── websocket.ts     # WebSocketManager (raw WS + binary demux)
│       │   │   ├── relay-client.ts  # RelayClient (protocol layer)
│       │   │   ├── phase-machine.ts # AppPhase state transitions
│       │   │   ├── ensure-binding.ts
│       │   │   ├── chat-dispatcher.ts
│       │   │   ├── session-dispatcher.ts
│       │   │   └── resource-dispatcher.ts
│       │   ├── hooks/
│       │   │   ├── use-relay-setup.ts   # main app init hook
│       │   │   ├── use-follow-output.ts # sticky-to-bottom for PTY/chat scroll
│       │   │   ├── use-visual-viewport.ts # iOS keyboard offset
│       │   │   ├── use-keyboard-shortcut.ts
│       │   │   ├── use-media-query.ts
│       │   │   └── use-sidebar-collapsed.ts
│       │   ├── lib/
│       │   │   ├── router.tsx       # createHashRouter (route table)
│       │   │   ├── create-xterm.ts  # xterm.js factory with WebGL addon
│       │   │   ├── xterm-theme.ts
│       │   │   ├── ansi-keys.ts     # key → ANSI escape
│       │   │   ├── terminal-replay.ts
│       │   │   ├── format-session-name.ts
│       │   │   └── utils.ts         # cn() etc.
│       │   ├── utils/
│       │   │   ├── relative-time.ts
│       │   │   └── summarize-tool-input.ts
│       │   └── __tests__/unit
│       ├── public/                  # PWA icons, brand-icon.svg, fixtures/
│       ├── scripts/convert-fixture.ts
│       ├── e2e/                     # Playwright specs
│       ├── index.html
│       ├── vite.config.ts           # VitePWA + dev proxy to :3100
│       ├── playwright.config.ts
│       ├── pwa-assets.config.ts
│       ├── components.json          # shadcn/ui config
│       ├── Dockerfile               # nginx-based, serves dist + fronts relay
│       └── package.json
│
├── packages/
│   └── shared/                      # @cc-anywhere/shared (workspace-only)
│       ├── src/
│       │   ├── index.ts             # barrel: schemas + types + builders + constants + logger
│       │   ├── schemas/
│       │   │   ├── envelope.ts      # MessageEnvelopeSchema (15 types, disc union on "type")
│       │   │   ├── chat.ts          # UserInput / AssistantMessage / Thinking payloads
│       │   │   ├── tool.ts          # ToolUseRequest / Approve / Deny / Result payloads
│       │   │   ├── session.ts       # SessionInfo / SessionList / SessionStatus / PtyState payloads
│       │   │   ├── system.ts        # Heartbeat / Error / Auth / Sync payloads
│       │   │   └── relay-control.ts # RelayControlSchema (~40 types — out-of-band protocol)
│       │   ├── types/index.ts       # re-exports schema-inferred types
│       │   ├── builders/index.ts    # buildMessage(type, sessionId, seq, payload, source)
│       │   ├── constants/
│       │   │   ├── errors.ts        # ErrorCode enum
│       │   │   └── session.ts       # SessionState enum
│       │   └── logger.ts            # pino createLogger
│       └── package.json
│
├── scripts/
│   ├── dev-restart.sh               # wipe + restart serve for dev
│   └── install-relay.sh             # one-liner installer pulling GHCR / ACR image
│
├── .planning/                       # GSD workflow artifacts (docs only, not code)
├── .claude/                         # Claude Code workspace (commands / hooks)
├── .github/                         # CI workflows (GHCR publish)
├── reference/                       # external prior-art snapshots
├── pnpm-workspace.yaml              # packages: packages/*, apps/*
├── pnpm-lock.yaml
├── package.json                     # root scripts (build/lint/test/typecheck)
├── tsconfig.base.json               # shared compiler options
├── tsconfig.json                    # project references root
├── eslint.config.js                 # flat config
├── .prettierrc
├── vitest.config.ts                 # root vitest (test scope dispatcher)
└── CLAUDE.md                        # project agent instructions
```

## Directory Purposes

**`apps/proxy/`:**
- Purpose: Local side of CC Anywhere. Published as `@lichenxi.cat/cc-anywhere` (bin: `cc-anywhere`).
- Contains: CLI entry, terminal wrapper process, serve daemon, session-worker child, all IPC/protocol glue.
- Key files: `src/terminal.ts`, `src/serve.ts`, `src/session-worker.ts`, `src/ipc-protocol.ts`, `src/relay-connection.ts`.
- Build: `tsup` produces ESM bundles for `index.ts`, `serve.ts`, `session-worker.ts`. `@cc-anywhere/shared` is inlined (`noExternal`) so the npm package is self-contained. `node-pty` stays external for native prebuilds.

**`apps/relay/`:**
- Purpose: Cloud-deployable WebSocket relay. Stateless. Published as `@lichenxi.cat/cc-anywhere-relay`.
- Contains: Server entry, Express HTTP, two WebSocket endpoints, registry, router.
- Key files: `src/server.ts` (construction), `src/router.ts` (parseMessage + route), `src/handlers/{proxy,client}.ts` (per-endpoint handlers), `src/registry.ts` (state).
- Deployment: `Dockerfile` + `docker-compose.yml` + `nginx.conf` + `deploy.sh` in the same directory; all coupled.

**`apps/web/`:**
- Purpose: React SPA, PWA, also the sole remote UI. Private package `@cc-anywhere/web`.
- Contains: React components, pages, zustand stores, services (WS + dispatchers), hooks, lib.
- Key files: `src/main.tsx`, `src/hooks/use-relay-setup.ts`, `src/services/{websocket,relay-client,phase-machine}.ts`, `src/components/chat/chat-pty-view.tsx`, `src/lib/create-xterm.ts`.
- Build: Vite + VitePWA. Hash router (not BrowserRouter) — so routes use `/#/chat/:id`.

**`packages/shared/`:**
- Purpose: Wire protocol single source of truth. Imported by all three apps.
- Contains: Zod schemas, inferred types, message builder, enums, pino logger factory.
- Key files: `src/schemas/envelope.ts`, `src/schemas/relay-control.ts`, `src/builders/index.ts`, `src/constants/session.ts`.
- Build: `tsup` + separate `tsc` pass for `.d.ts`. Consumers import from `dist/` — **must rebuild after schema edits** (see memory: "Shared 包 rebuild").

**`scripts/`:**
- `dev-restart.sh`: kills running serve, wipes socket/pid, restarts via `pnpm --filter proxy run dev -- serve`.
- `install-relay.sh`: end-user installer that pulls the published image from GHCR (default) or Aliyun ACR (`REGISTRY_BASE` override) and runs docker compose.

**`reference/`:**
- External project snapshots (cc-connect, Claude-to-IM). Not imported; read-only references. Never modify.

**`.planning/`:**
- GSD workflow scratch space. Contains `PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md`, phase plans, research notes, codebase maps (this file's home).

## Key File Locations

**Entry Points:**
- `apps/proxy/src/index.ts`: CC Anywhere CLI, `bin` entry.
- `apps/proxy/src/serve.ts::startService`: daemon main.
- `apps/proxy/src/terminal.ts::startTerminal`: PTY wrapper main.
- `apps/proxy/src/session-worker.ts`: JSON-mode worker main (script-style, module-level side effects).
- `apps/relay/src/index.ts`: relay main.
- `apps/web/src/main.tsx`: React root.
- `apps/web/index.html`: Vite entry HTML.

**Configuration:**
- `apps/proxy/src/config.ts`: loads `~/.cc-anywhere/config.json` (relayUrl, relayToken).
- `apps/proxy/src/paths.ts`: all proxy runtime paths in one place — `SOCK_PATH`, `PID_PATH`, `SESSIONS_PATH`, `DATA_DIR`, `LOG_PATH`, `sessionPaths(id)`.
- `apps/relay/src/index.ts`: env vars — `PORT`, `DATA_DIR`, `HEARTBEAT_INTERVAL`, `RELAY_PROXY_TOKEN`, `LOG_LEVEL`.
- `apps/web/vite.config.ts`: dev proxy, PWA manifest, service worker config.
- Root `tsconfig.base.json`: shared compiler options.
- Root `eslint.config.js`: flat ESLint config (global rules).
- Root `.prettierrc`: formatter.

**Protocols / Schemas:**
- `packages/shared/src/schemas/envelope.ts`: `MessageEnvelope` (payload-carrying, seq'd, signed with source).
- `packages/shared/src/schemas/relay-control.ts`: `RelayControlMessage` (transport-layer, flat, ~40 types). This is where the majority of proxy↔client semantics actually live — envelope is a minority of types.
- `apps/proxy/src/ipc-protocol.ts`: `IpcMessageSchema` (terminal ↔ serve), `WorkerMessageSchema` (serve ↔ worker), binary frame encoder/decoder.
- `packages/shared/src/constants/session.ts`: `SessionState` string enum.

**PTY pipeline:**
- `apps/proxy/src/pty-manager.ts`: node-pty spawn + stdio bridging.
- `apps/proxy/src/terminal.ts`: tap closure, OSC extraction, xterm headless mirror, snapshot emission.
- `apps/proxy/src/osc-extractor.ts`: OSC 0/9 parser (title, notifications).
- `apps/web/src/lib/create-xterm.ts`: xterm.js factory (WebGL + Sarasa Fixed SC).
- `apps/web/src/components/chat/chat-pty-view.tsx`: the only consumer of `subscribeBinary` — owns the xterm instance for display.
- `apps/web/src/lib/ansi-keys.ts`: maps virtual key events to ANSI byte sequences for `remote_input_raw`.

**WebSocket routing:**
- `apps/relay/src/server.ts`: HTTP upgrade handler, `/proxy` vs `/client` split, auth token check.
- `apps/relay/src/router.ts`: `parseMessage` (control-first, envelope-fallback), `routeProxyMessage`, `routeClientMessage`.
- `apps/relay/src/handlers/proxy.ts`: proxy lifecycle, binary passthrough, `PROXY_TO_CLIENT_TYPES` allowlist.
- `apps/relay/src/handlers/client.ts`: client lifecycle, binding, `CLIENT_TO_PROXY_TYPES` allowlist.
- `apps/relay/src/registry.ts`: `RelayRegistry` (only place where relay state lives).
- `apps/proxy/src/relay-connection.ts`: proxy-side outbound WS manager.
- `apps/web/src/services/websocket.ts`: browser-side raw WS manager with binary demux.
- `apps/web/src/services/relay-client.ts`: browser-side protocol layer.

**Session management:**
- `apps/proxy/src/session-manager.ts`: sole authority on session state in proxy process.
- `apps/proxy/src/session-history.ts`: reads `~/.claude/projects/*/*.jsonl` for resume.
- `apps/web/src/stores/session-store.ts`: browser-side session list.
- `apps/web/src/stores/chat-store.ts`: per-session chat message slices.

**Nginx / deployment:**
- `apps/relay/nginx.conf`: request path routing (`/proxy`, `/client` → WS; `/fonts`, `/health`, `/status`, `/api/*` → relay HTTP; else → SPA with `try_files ... /index.html`).
- `apps/relay/docker-compose.yml`: two services (relay, nginx), shared volume for relay-data (fonts).
- `apps/relay/deploy.sh`: SSH + certbot + token provisioning + smoke test.
- `apps/web/Dockerfile`: nginx image baking in built SPA.

## Naming Conventions

**Files:**
- Source files: `kebab-case.ts` (`relay-connection.ts`, `session-manager.ts`, `ipc-protocol.ts`).
- React components: `kebab-case.tsx` (`chat-pty-view.tsx`, `input-bar.tsx`, `tool-approval-card.tsx`).
- Test files: co-located `*.test.ts` / `*.test.tsx` where convenient (e.g. `stores/chat-store.test.ts`, `components/chat/markdown-view.test.tsx`), otherwise under `src/__tests__/unit|integration/`.
- E2E specs: `apps/web/e2e/*.spec.ts` (Playwright).
- Config files: lowercase with conventional extensions (`vite.config.ts`, `tsup.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `tsconfig.app.json`).

**Directories:**
- All lowercase. `apps/`, `packages/`, `src/`, `components/`, `stores/`, `services/`, `hooks/`, `lib/`, `utils/`, `pages/`, `handlers/`, `schemas/`, `constants/`, `types/`, `builders/`, `__tests__/` (with `unit/` and `integration/` subdirs).
- No index barrels inside feature dirs — imports reference specific files (e.g. `@/components/chat/input-bar`, not `@/components/chat`). Exception: `packages/shared/src/index.ts` is the package barrel.

**Functions:**
- camelCase. Handler functions prefixed with verb: `handleProxyConnection`, `handleTerminalConnection`, `routeProxyMessage`, `buildMessage`, `changeSessionState`.
- React components: PascalCase exported function (`ChatPtyView`, `InputBar`).
- Hooks: `useXxx` (`useRelaySetup`, `useFollowOutput`, `useVisualViewportBottomOffset`).

**Types:**
- PascalCase, interface preferred over `type` alias except for zod inferences (`export type MessageEnvelope = z.infer<typeof MessageEnvelopeSchema>`).
- Schema names suffixed `Schema` (`MessageEnvelopeSchema`, `RelayControlSchema`, `SessionInfoSchema`).
- String enums as `const` objects + derived type (`export const SessionState = { IDLE: "idle", ... } as const; export type SessionState = (typeof SessionState)[keyof typeof SessionState]`). See `apps/proxy/src/terminal.ts:26-34` and `apps/proxy/src/relay-connection.ts:24-32`.

**Message types (wire):**
- snake_case literals: `user_input`, `assistant_message`, `tool_use_request`, `session_create`, `pty_state_push`, `proxy_register`.
- Request/response pairing: `xxx_request` / `xxx_response` (e.g. `proxy_list_request` / `proxy_list_response`, `session_messages_request` / `session_history_messages` — note asymmetry here).
- Push messages: `xxx_push` (`pending_approvals_push`, `command_list_push`, `file_tree_push`).

**Path aliases:**
- Web: `@/*` → `apps/web/src/*` (configured in `vite.config.ts` and `tsconfig.app.json`).
- Proxy + relay: `#src/*` → `./src/*` via `package.json#imports` field.

## Where to Add New Code

**New wire message type:**
- Add zod schema to `packages/shared/src/schemas/relay-control.ts` (for control) or appropriate payload file + wire into `packages/shared/src/schemas/envelope.ts` (for envelope).
- Rebuild shared: `pnpm --filter shared run build`.
- If proxy → client: add to `PROXY_TO_CLIENT_TYPES` in `apps/relay/src/handlers/proxy.ts:10`.
- If client → proxy: add to `CLIENT_TO_PROXY_TYPES` in `apps/relay/src/handlers/client.ts:8`.
- Proxy send site: typically in `apps/proxy/src/serve.ts`. Consume site: `apps/web/src/services/*-dispatcher.ts` (pick the right one by domain).

**New IPC message (terminal ↔ serve or serve ↔ worker):**
- Add variant to `IpcMessageSchema` or `WorkerMessageSchema` in `apps/proxy/src/ipc-protocol.ts`.
- Handle in terminal's `createIpcReader` callback (`terminal.ts:131-160`) or worker's socket handler (`session-worker.ts`).
- Handle in serve's `handleTerminalConnection` switch (`serve.ts:419-689`) or `connectToWorker` callback (`serve.ts:235-320`).

**New React page:**
- File: `apps/web/src/pages/<name>.tsx`, export a `PageName` component.
- Route: add entry in `apps/web/src/lib/router.tsx` — as child of `AppShell` if it should get sidebar/header chrome, or as sibling if debug/standalone.

**New React component:**
- Reusable UI primitive: `apps/web/src/components/ui/<name>.tsx` (shadcn/ui style).
- Feature component: appropriate subdir under `apps/web/src/components/{chat,session,proxy,shell,brand}/`.
- If it needs cross-session state: new store in `apps/web/src/stores/`, or slice of existing store.

**New zustand store:**
- File: `apps/web/src/stores/<name>-store.ts`. Use `create<State>()(devtools((set) => ({...})))` pattern.
- Wrap reads in selectors at call site for minimal re-render surface.

**New message dispatcher:**
- File: `apps/web/src/services/<domain>-dispatcher.ts`.
- Export `register<Domain>Dispatcher(): () => void` (unregister fn).
- Call from `useRelaySetup` in `apps/web/src/hooks/use-relay-setup.ts`.

**New relay-side logic:**
- Route-level: `apps/relay/src/router.ts` or a new `handlers/<name>.ts`.
- State: extend `RelayRegistry` in `apps/relay/src/registry.ts`. Keep all state here — do not sneak state into handler closures.

**New CLI subcommand:**
- Add to commander tree in `apps/proxy/src/index.ts`. Follow existing `serve.command("...")` pattern.

**New Claude Code integration (proxy side):**
- PTY side: extend `apps/proxy/src/terminal.ts` tap closure (but think hard — most things belong in serve).
- JSON side: extend `apps/proxy/src/json-session.ts` (wraps claude CLI) or `session-worker.ts` (IPC shell around JsonSession).

**New runtime path under `~/.cc-anywhere/`:**
- Define constant in `apps/proxy/src/paths.ts`. Do not hardcode elsewhere (per root `CLAUDE.md`: "避免在代码中硬编码目录路径").

**New test:**
- Unit: co-located `*.test.ts` for stores/utils, or `src/__tests__/unit/` for heavier tests.
- Integration: `src/__tests__/integration/` (proxy + relay have these).
- Schema: `packages/shared/src/schemas/__tests__/*.test.ts`.
- E2E: `apps/web/e2e/*.spec.ts`. Requires relay + proxy running.

## Special Directories

**`~/.cc-anywhere/` (user home, runtime):**
- Purpose: Proxy runtime state. Created by `cc-anywhere init` (`apps/proxy/src/paths.ts::initWorkspace`).
- Generated: Yes.
- Committed: No (user-local).
- Layout: `config.json` (user config), `run/` (sock + pid + stopped), `state/sessions.json` (persisted SessionInfo), `data/<sessionId>/` (worker.sock per live session), `logs/service.log`, `proxy-id` (persistent nanoid).

**`~/.cc-anywhere/relay-data/` (server side, for relay):**
- Purpose: Relay-side font shards (CJK split fonts) served via `/fonts`.
- Generated: Yes, provisioned during deployment (`apps/relay/deploy.sh` rsyncs from local machine).
- Path determined by `DATA_DIR` env or falls back to this default.

**`.planning/codebase/`:**
- Purpose: Codebase map docs (this file, ARCHITECTURE.md, STACK.md, etc.).
- Generated: By `/gsd-map-codebase` (re-runnable). Consumed by `/gsd-plan-phase` and `/gsd-execute-phase`.
- Committed: Yes.

**`dist/` (per-app):**
- Purpose: Build output from tsup (proxy, relay, shared) or Vite (web).
- Generated: Yes (`pnpm -r run build`).
- Committed: No (`.gitignore`). `packages/shared/dist/` is the import target for the other workspaces, so it must exist locally — `pnpm install` + `pnpm -r run build` on fresh checkout.

**`reference/`:**
- Purpose: External prior-art code snapshots (cc-connect, Claude-to-IM).
- Generated: No, hand-curated.
- Committed: Yes. **Read-only — do not modify.**

**`test-results/`, `.playwright-mcp/`:**
- Purpose: Playwright run artifacts.
- Generated: Yes.
- Committed: No.

---

*Structure analysis: 2026-04-20*
