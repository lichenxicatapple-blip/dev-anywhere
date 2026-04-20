# Technology Stack

**Analysis Date:** 2026-04-20

This is a pnpm monorepo with four workspaces: `packages/shared`, `apps/proxy`, `apps/relay`, `apps/web`. All versions below come directly from the per-workspace `package.json` files on disk, not from CLAUDE.md.

## Languages

**Primary:**
- TypeScript `^5.8.2` (root devDep `package.json` L28; `apps/web` devDep L54). Full-stack: frontend, backend, CLI, shared schema.

**Config language:**
- JSON (tsconfig, package.json, `.prettierrc`)
- YAML (`pnpm-workspace.yaml`, `.github/workflows/release.yml`)
- Bash (`apps/relay/deploy.sh`, `scripts/install-relay.sh`, `.husky/pre-commit`)
- Dockerfile (`apps/relay/Dockerfile`, `apps/web/Dockerfile`)
- Nginx (`apps/relay/nginx.conf`)

## Runtime

**Environment:**
- Node.js `>=20` — declared in `apps/proxy/package.json` L26 and `apps/relay/package.json` L26 (`engines.node`). Release workflow CI uses Node 20 (`.github/workflows/release.yml` L96). Docker images pin `node:22-alpine` (`apps/relay/Dockerfile` L2, `apps/web/Dockerfile` L2), so production actually runs Node 22 even though the floor is 20.

**TS compile target:**
- `ES2022` / `module: ESNext`, `moduleResolution: bundler` (`tsconfig.base.json`). All workspaces `"type": "module"` (ESM only).
- `tsup` bundles `target: node20` for proxy and relay (`apps/proxy/tsup.config.ts` L12, `apps/relay/tsup.config.ts` L11).

**Package Manager:**
- pnpm `^9.x` — declared in GitHub Actions `pnpm/action-setup@v4` with `version: 9` (`.github/workflows/release.yml` L92) and `corepack prepare pnpm@9 --activate` in both Dockerfiles.
- Lockfile: `pnpm-lock.yaml` (419KB, committed).
- Workspace config: `pnpm-workspace.yaml` — `packages: [packages/*, apps/*]`.
- `pnpm.onlyBuiltDependencies`: `esbuild`, `@esbuild/*`, `node-pty` (`package.json` L33-37). `pnpm.overrides` pins `@types/react`, `@types/react-dom` to `^19.1.6` for the whole tree.

## Frameworks

### Claude Code integration (`apps/proxy`)

| Package | Version | Purpose |
|---------|---------|---------|
| `node-pty` | `^1.1.0` | PTY wrapping for transparent local terminal. `apps/proxy/src/pty-manager.ts` spawns `claude` CLI via `pty.spawn()`. |
| `@xterm/headless` | `^6.0.0` | In-process headless terminal emulator for remote snapshot serialization (`apps/proxy/src/terminal.ts` L8-9). |
| `@xterm/addon-serialize` | `^0.14.0` | Serializes headless terminal state for `session_snapshot` RelayControl. |
| `@xterm/addon-unicode-graphemes` | `^0.4.0` | Unicode v15 grapheme cluster width calculation; loaded on both proxy headless terminal and web xterm. |

**Claude CLI interaction:**
- **PTY mode:** `apps/proxy/src/pty-manager.ts` L6-14 resolves `claude` via `which claude` or `CLAUDE_BIN` env. Arguments forwarded verbatim.
- **stream-json mode:** `apps/proxy/src/json-session.ts` L138-157 spawns `claude --output-format stream-json --input-format stream-json --permission-prompt-tool stdio --permission-mode <mode> --verbose --fork-session [--resume <id>]` via `child_process.spawn`. No SDK.

### Relay server (`apps/relay`)

| Package | Version | Purpose |
|---------|---------|---------|
| `express` | `^5.1.0` | HTTP for `/health`, `/status`, `/api/status`, `/api/proxies`, `/api/clients`, `/fonts`. See `apps/relay/src/server.ts`, `apps/relay/src/health.ts`. |
| `ws` | `^8.20.0` | Two `WebSocketServer` instances with `noServer: true` — `/proxy` and `/client` paths, both multiplexed on one HTTP server via `httpServer.on("upgrade", ...)` (`apps/relay/src/server.ts` L52-83). |

### Web SPA (`apps/web`)

| Package | Version | Purpose |
|---------|---------|---------|
| `react` | `^19.1.0` | UI framework. Uses React 19 `StrictMode`, new Suspense semantics. |
| `react-dom` | `^19.1.0` | Client-side rendering (`apps/web/src/main.tsx`). |
| `react-router` | `^7.14.1` | Routing (`apps/web/src/lib/router.tsx`). Hash-mode per CLAUDE.md. |
| `vite` | `^6.3.5` | Dev server + build. Config in `apps/web/vite.config.ts`. |
| `@vitejs/plugin-react` | `^4.5.2` | JSX / Fast Refresh. |
| `tailwindcss` | `^4.1.8` | Utility CSS. Installed as Vite plugin (`@tailwindcss/vite` `^4.1.8`). |
| `@tailwindcss/typography` | `^0.5.19` | Markdown prose styling. |
| `vite-plugin-pwa` | `^1.2.0` | PWA manifest + Workbox service worker. Config: `registerType: "autoUpdate"`. |
| `@vite-pwa/assets-generator` | `^1.0.2` (dev) | Generates PWA icons from `public/brand-icon.svg` via `pwa-assets.config.ts`. |

**Terminal rendering (web):**
| Package | Version | Purpose |
|---------|---------|---------|
| `@xterm/xterm` | `6.0.0` (pinned) | Browser terminal emulator. `apps/web/src/lib/create-xterm.ts`. |
| `@xterm/addon-webgl` | `^0.19.0` | WebGL renderer for cell-accurate CJK / box-drawing alignment. |
| `@xterm/addon-fit` | `0.11.0` (pinned) | Resize terminal to container. |
| `@xterm/addon-serialize` | `0.14.0` (pinned) | Client-side replay state serialization. |
| `@xterm/addon-web-links` | `0.12.0` (pinned) | Clickable URLs. |
| `@xterm/addon-unicode-graphemes` | `^0.4.0` | Same as proxy. |

**UI components:**
| Package | Version | Purpose |
|---------|---------|---------|
| `radix-ui` | `^1.4.3` | Umbrella package for Radix primitives. |
| `@radix-ui/react-slot` | `^1.2.4` | shadcn/ui slot pattern. |
| `class-variance-authority` | `^0.7.1` | CVA variant helpers for shadcn/ui. |
| `clsx` | `^2.1.1` | Conditional class names. |
| `tailwind-merge` | `^3.5.0` | Tailwind class deduplication. |
| `tw-animate-css` | `^1.4.0` (dev) | Tailwind CSS animation utilities. |
| `cmdk` | `^1.1.1` | Command palette (used in slash-command picker). |
| `lucide-react` | `^1.8.0` | Icon set. |
| `sonner` | `^2.0.7` | Toast notifications (`apps/web/src/components/toast.tsx`, `apps/web/src/components/ui/sonner.tsx`). |

**shadcn/ui:** configured via `apps/web/components.json` with `style: "new-york"`, `baseColor: "neutral"`, aliases `@/components`, `@/lib/utils`, etc.

**State management:**
- `zustand` `^5.0.12` — stores in `apps/web/src/stores/` (`app-store.ts`, `chat-store.ts`, `session-store.ts`, `command-store.ts`, `file-store.ts`).

**Virtualization:**
- `@tanstack/react-virtual` `^3.13.24` — likely used for chat / session list.

**Markdown rendering:**
| Package | Version | Purpose |
|---------|---------|---------|
| `react-markdown` | `^10.1.0` | Markdown → React. |
| `remark-gfm` | `^4.0.1` | GitHub-flavored markdown. |
| `rehype-highlight` | `^7.0.2` | Code syntax highlighting plugin. |
| `highlight.js` | `^11.11.1` | Highlight.js core. |

### Shared schema (`packages/shared`)

| Package | Version | Purpose |
|---------|---------|---------|
| `zod` | `^4.3.6` | Runtime schema validation for protocol. `MessageEnvelopeSchema` (15-variant discriminated union) in `packages/shared/src/schemas/envelope.ts`, `RelayControlSchema` (~40 variants) in `packages/shared/src/schemas/relay-control.ts`. |
| `nanoid` | `^5.1.7` | ID generation for sessions, request IDs, proxy IDs. |
| `pino` | `^10.3.1` | Shared logger factory (`packages/shared/src/logger.ts`). Multistream file + stdout. |

### Testing

| Package | Version | Purpose |
|---------|---------|---------|
| `vitest` | `^4.1.2` | Test runner. Root config uses `projects: ["packages/*", "apps/*"]` (`vitest.config.ts`). Every workspace has its own `vitest.config.ts`. |
| `@vitest/coverage-v8` | `^4.1.4` (root dev) | V8 coverage reporter. |
| `@playwright/test` | `^1.52.0` (`apps/web` dev) | E2E tests in `apps/web/e2e/*.spec.ts`. Config pins `mobile` (390x844) + `desktop` (1280x800) viewports. |
| `@testing-library/react` | `^16.3.2` (`apps/web` dev) | Component tests. |
| `@testing-library/jest-dom` | `^6.9.1` (`apps/web` dev) | DOM matchers. |
| `jsdom` | `^26.1.0` (`apps/web` dev) | DOM environment for vitest. |

### Build & Dev Tooling

| Package | Version | Scope | Purpose |
|---------|---------|-------|---------|
| `tsup` | `^8.5.1` | root dev | Bundler for proxy / relay / shared. `format: ["esm"]`, `target: node20`. See `apps/proxy/tsup.config.ts`, `apps/relay/tsup.config.ts`, `packages/shared/tsup.config.ts`. Proxy & relay inline `@cc-anywhere/shared` via `noExternal`. |
| `tsx` | `^4.21.0` | root dev | TypeScript runtime for `pnpm run dev`, daemonized `serve`, `session-worker` spawning in dev mode. |
| `eslint` | `^10.1.0` | root dev | Flat config in `eslint.config.js`. `@eslint/js` `^10.0.1`, `typescript-eslint` `^8.58.0`, `eslint-config-prettier` `^10.1.8`, `eslint-plugin-react-hooks` `^7.1.1` (scoped to `apps/web`). |
| `prettier` | `^3.8.1` | root dev | `.prettierrc`: `semi: true, singleQuote: false, trailingComma: all, printWidth: 100, tabWidth: 2`. |
| `globals` | `^17.4.0` | root dev | ESLint globals. |

### Supporting Libraries (per-app)

**`apps/proxy`:**
| Package | Version | Purpose |
|---------|---------|---------|
| `commander` | `^14.0.3` | CLI argument parsing (`apps/proxy/src/index.ts`). |
| `ws` | `^8.20.0` | Outbound WebSocket client to relay (`apps/proxy/src/relay-connection.ts`). |
| `pino` | `^10.3.1` | Logger (re-exports `createLogger` from shared). |
| `nanoid` | `^5.1.7` | proxyId generation, request IDs. |
| `zod` | `^4.3.6` | Schema validation on inbound messages. |

**`apps/relay`:**
| Package | Version | Purpose |
|---------|---------|---------|
| `express` | `^5.1.0` | HTTP router. |
| `ws` | `^8.20.0` | WebSocket servers. |
| `pino` | `^10.3.1` | Logger. |
| `nanoid` | `^5.1.7` | ID generation. |
| `zod` | `^4.3.6` | Schema validation on inbound messages. |

## Version Drift & Notable Mismatches

| Package | `apps/proxy` | `apps/relay` | `apps/web` | Notes |
|---------|-------------|-------------|-----------|-------|
| `@types/node` | `^25.5.2` | `^22.15.30` | `^22.15.30` | Proxy is ahead. Possibly ties to the Node 22 Docker images; low risk but not uniform. |
| `@types/ws` | `^8.18.1` | `^8.18.1` | — | Consistent. |
| `vitest` | `^4.1.2` | `^4.1.2` | `^4.1.2` | Consistent with root. |
| `typescript` | (inherits root `^5.8.2`) | (inherits root) | `^5.8.2` (explicit dev) | Web duplicates the declaration; no version drift. |

**CLAUDE.md drift (stated vs. actual):**
| Claim in root `CLAUDE.md` | Actual in `package.json` |
|---------------------------|--------------------------|
| TypeScript `^5.5` | `^5.8.2` |
| `tsup` `^8.x` | `^8.5.1` |
| `commander` `^12.x` | `^14.0.3` |
| `pino` `^9.x` | `^10.3.1` |
| `zod` `^3.24` | `^4.3.6` (zod v4, major semver change — watch API differences) |
| `nanoid` `^5.x` | `^5.1.7` |
| `vitest` `^2.x` | `^4.1.2` |
| `express or fastify` (express `^4.21`) | `express` `^5.1.0` (Express v5 adopted) |
| `reconnecting-websocket` `^4.4.0` | **Not installed.** Proxy uses a hand-rolled reconnection in `apps/proxy/src/relay-connection.ts`; web uses a hand-rolled one in `apps/web/src/services/websocket.ts`. CLAUDE.md is stale on this. |
| `strip-ansi` `^7.2.0` | **Not installed.** No usages found. |
| `dotenv` `^16.x` | **Not installed.** Config reads `process.env` directly (`apps/proxy/src/config.ts`) plus a hand-read JSON at `~/.cc-anywhere/config.json`. |
| React `^19` | `^19.1.0` |
| `@xterm/addon-webgl` `0.19` | `^0.19.0` |
| `@xterm/xterm` `6.0` | `6.0.0` (pinned, not caret) |

**Feishu / Taro:** CLAUDE.md mentions Taro + Feishu mini program heavily. **Not present** in the codebase. Workspace has been migrated to Vite + React SPA + PWA per memory `project_migrate_to_spa`. The tsconfig references `{ "path": "apps/feishu" }` (root `tsconfig.json` L6), but the directory does not exist — stale reference.

## Configuration

**Environment variables (consumed at runtime):**

Proxy (`apps/proxy`):
- `RELAY_URL` — falls back to `~/.cc-anywhere/config.json` `relayUrl` field (`config.ts` L22).
- `RELAY_PROXY_TOKEN` — pre-shared token for `/proxy` endpoint (`config.ts` L23).
- `CLAUDE_BIN` — override `claude` binary path (`pty-manager.ts` L7, `json-session.ts` L153).
- `INIT_CWD` — working directory passed from shell wrapper (`terminal.ts` L112).
- `TERM` — PTY terminal type, default `xterm-256color` (`pty-manager.ts` L49).
- `CC_ANYWHERE_PROXY_NAME` — overrides auto-detected proxy name (`serve.ts` L778).
- `HOME` / `USERPROFILE` — for `~/.cc-anywhere/` workspace root.

Relay (`apps/relay`):
- `PORT` — default `3100` (`index.ts` L4).
- `DATA_DIR` — default `~/.cc-anywhere/relay-data`; empty string disables persistence (`index.ts` L5-7).
- `HEARTBEAT_INTERVAL` — default `30000` ms (`index.ts` L8).
- `RELAY_PROXY_TOKEN` — if set, `/proxy` WS endpoint requires `?token=` query param. Unset = open (dev only).
- `LOG_LEVEL` — default `info` (`index.ts` L13).

**Local workspace layout (proxy):**
Documented in `apps/proxy/src/paths.ts`:
- `~/.cc-anywhere/config.json` — proxy config
- `~/.cc-anywhere/run/{cc-anywhere.sock, cc-anywhere.pid, stopped}` — daemon IPC + lifecycle
- `~/.cc-anywhere/state/sessions.json` — persistent session metadata
- `~/.cc-anywhere/data/<sessionId>/{events.bin, worker.sock}` — per-session data
- `~/.cc-anywhere/logs/service.log` — pino log output

**Secret files noted only (not read):**
- `.env` / `.env.*` — gitignored (`.gitignore` L4-5). Generated on VPS by deploy scripts at `/opt/cc-anywhere/.env` with `RELAY_PROXY_TOKEN`.

**Build configs:**
- Root: `tsconfig.base.json`, `tsconfig.json` (project references), `eslint.config.js`, `.prettierrc`, `vitest.config.ts`.
- Per-app tsconfigs extend `tsconfig.base.json`; `apps/web` splits into `tsconfig.app.json` (`@/*` alias, DOM types) and `tsconfig.node.json` (Vite config types).

## Platform Requirements

**Development:**
- Node.js >=20 LTS (Node 22 recommended to match CI/prod).
- pnpm 9.
- Claude Code CLI in PATH (or `CLAUDE_BIN` set).
- For `node-pty` native module: Python and C++ toolchain if prebuild unavailable. Root `postinstall` hook fixes darwin spawn-helper permissions (`package.json` L16).

**Production:**
- Relay runs as Docker container (`node:22-alpine` base, multi-stage build with `pnpm deploy --prod`, final image ~173MB per recent commit message).
- Web SPA served via nginx container (built from `apps/web/dist`, config at `apps/relay/nginx.conf`).
- TLS: Let's Encrypt / certbot standalone, cert path `/etc/letsencrypt/live/relay/`.
- Deployment scripts: `apps/relay/deploy.sh` (source build), `scripts/install-relay.sh` (pre-built GHCR image pull).

**CI/CD:**
- GitHub Actions workflow `.github/workflows/release.yml` triggers on `v*.*.*` tags.
- Builds two Docker images (`cc-anywhere-relay`, `cc-anywhere-web`) and pushes to GHCR, optionally mirroring to Aliyun ACR (requires `ACR_REGISTRY`, `ACR_USERNAME`, `ACR_PASSWORD`, `ACR_NAMESPACE` secrets).
- Publishes npm packages `@lichenxi.cat/cc-anywhere` and `@lichenxi.cat/cc-anywhere-relay` with `NODE_AUTH_TOKEN=NPM_TOKEN`.

**Git hooks:**
- `.husky/pre-commit` runs `pnpm lint` + `pnpm -r run typecheck`. Husky itself is not in `package.json` — hook is installed manually.

---

*Stack analysis: 2026-04-20*
