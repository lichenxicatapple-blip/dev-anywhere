<!-- GSD:project-start source:PROJECT.md -->

## Project

**CC Anywhere**

CC Anywhere 是 Claude Code 的透明代理和远程控制系统。它在本地包装 Claude Code CLI 进程，保持终端体验完全一致，同时通过中转服务器将会话桥接到移动端 Web SPA（浏览器/PWA），让用户在手机上也能像在电脑前一样与 Claude Code 实时交互。面向开发者的开源工具。

**Core Value:** 在任何地方（电脑或手机）都能与 Claude Code 实时交互，体验一致，不丢失上下文。

### Constraints

- **Tech Stack**: TypeScript -- 前后端统一，与 Claude Code 同技术栈
- **Runtime**: 本地代理运行在用户电脑上，中转服务器需要公网可访问
- **Platform**: 移动端 Web SPA（浏览器/PWA）作为移动端入口
- **Dependency**: 依赖 Claude Code CLI，需要用户本地已安装
- **UX**: 本地代理必须对 Claude Code 原生终端体验完全透明，用户回到电脑操作时不能有任何干扰
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->

## Technology Stack

## Architecture Decision: PTY + stream-json Dual Mode

- PTY (node-pty) for transparent local terminal wrapping
- `claude --output-format stream-json --input-format stream-json` for remote programmatic control
- JSON event stream provides structured output (text deltas, tool calls, status)
- `--permission-prompt-tool stdio` for programmatic tool approval
- No third-party SDK dependency, only relies on Claude Code CLI itself

## Recommended Stack

### Core: Claude Code Interface

| Technology                               | Version | Purpose                                           | Why                                                                                         | Confidence |
| ---------------------------------------- | ------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------- |
| `node-pty`                               | ^1.1.0  | Local transparent terminal wrapping               | Microsoft-maintained. Used by VS Code terminal. Only library providing real PTY on Node.js. | HIGH       |
| Claude Code CLI (`claude --stream-json`) | latest  | Remote programmatic control via JSON event stream | No SDK dependency. cc-connect validated approach. Immune to SDK API churn.                  | HIGH       |

### Core: Runtime & Language

| Technology | Version  | Purpose         | Why                                                                                              | Confidence |
| ---------- | -------- | --------------- | ------------------------------------------------------------------------------------------------ | ---------- |
| Node.js    | >=20 LTS | Runtime         | Required by node-pty. LTS for stability. Matches Claude Code's own runtime.                      | HIGH       |
| TypeScript | ^5.5     | Language        | Project constraint. Full-stack consistency.                                                      | HIGH       |
| pnpm       | ^9.x     | Package manager | Monorepo workspace support. Faster than npm. Strict dependency resolution prevents phantom deps. | HIGH       |

### Core: Relay Server

| Technology             | Version                      | Purpose                                    | Why                                                                                                                                              | Confidence |
| ---------------------- | ---------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| `ws`                   | ^8.20.0                      | WebSocket server & client                  | Most popular Node.js WebSocket library. Lightweight, fast, well-tested. Used by 60k+ npm packages. No unnecessary abstraction over the protocol. | HIGH       |
| `zod`                  | ^3.24                        | Message schema validation                  | TypeScript-first runtime validation. Shared schemas between proxy, relay, and mini program. Prevents protocol drift.                             | HIGH       |
| `express` or `fastify` | express ^4.21 / fastify ^5.x | HTTP server for health checks, session API | Lightweight HTTP alongside WebSocket. Express for simplicity; Fastify if performance matters.                                                    | HIGH       |

### Core: Web SPA

| Technology             | Version    | Purpose                  | Why                                                                            | Confidence |
| ---------------------- | ---------- | ------------------------ | ------------------------------------------------------------------------------ | ---------- |
| React                  | ^19        | UI framework             | Team familiarity; React 19 feature set.                                        | HIGH       |
| Vite                   | ^6         | SPA bundler / dev server | Fast HMR, ES modules, TypeScript-first.                                        | HIGH       |
| Tailwind CSS           | ^4         | Styling                  | Utility-first; design tokens live in CSS vars.                                 | HIGH       |
| xterm.js + addon-webgl | 6.0 / 0.19 | PTY 可视化               | cell-grid 精确对齐，CJK/box-drawing 稳定；WebGL 避免 DOM letter-spacing 问题。 | HIGH       |

### Supporting Libraries

| Library                  | Version | Purpose                                                                  | Confidence |
| ------------------------ | ------- | ------------------------------------------------------------------------ | ---------- |
| `strip-ansi`             | ^7.2.0  | Strip ANSI escape codes from terminal output for logging/display         | HIGH       |
| `nanoid`                 | ^5.x    | Generate compact, URL-safe unique IDs for sessions/messages              | HIGH       |
| `reconnecting-websocket` | ^4.4.0  | Auto-reconnecting WebSocket client wrapper (for proxy->relay connection) | HIGH       |
| `pino`                   | ^9.x    | Structured JSON logging for relay server                                 | HIGH       |
| `commander`              | ^12.x   | CLI argument parsing for local proxy                                     | HIGH       |
| `dotenv`                 | ^16.x   | Environment variable management                                          | HIGH       |
| `vitest`                 | ^2.x    | Testing framework                                                        | HIGH       |

### Build & Development

| Technology | Version | Purpose                                          | Why                                                                                                                              | Confidence |
| ---------- | ------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `tsup`     | ^8.x    | Bundle TypeScript for proxy CLI and relay server | Zero-config, esbuild-powered. Fast builds. Note: tsup maintenance has slowed; tsdown is the successor but not yet mature enough. | MEDIUM     |
| `tsx`      | ^4.x    | TypeScript execution for development             | Faster than ts-node. Uses esbuild.                                                                                               | HIGH       |
| `eslint`   | ^9.x    | Linting with flat config                         | Standard.                                                                                                                        | HIGH       |
| `prettier` | ^3.x    | Code formatting                                  | Standard.                                                                                                                        | HIGH       |

### Infrastructure

| Technology       | Purpose                        | Why                                                   | Confidence |
| ---------------- | ------------------------------ | ----------------------------------------------------- | ---------- |
| Docker           | Relay server containerization  | Standard deployment. Single Dockerfile for the relay. | HIGH       |
| Nginx (optional) | TLS termination, reverse proxy | Only if relay needs HTTPS/WSS in front.               | MEDIUM     |

## Monorepo Structure

## Alternatives Considered

| Category               | Recommended                   | Alternative                | Why Not                                                                                                                        |
| ---------------------- | ----------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code interface  | node-pty + stream-json (dual) | PTY-only with ANSI parsing | Fragile parsing of terminal UI. Breaks on Claude Code updates.                                                                 |
| Claude Code interface  | node-pty + stream-json (dual) | Agent SDK                  | Unstable v0.2.x API, unnecessary dependency when CLI stream-json provides the same capability.                                 |
| WebSocket              | ws                            | Socket.IO                  | Over-engineered. We control both ends.                                                                                         |
| WebSocket              | ws                            | uWebSockets.js             | Premature optimization for personal-scale tool                                                                                 |
| Mini program framework | Taro + React                  | Native Feishu TTML         | Poor DX. No TypeScript-first support. Small ecosystem.                                                                         |
| Mini program framework | Taro + React                  | uni-app                    | Vue-oriented. React support is secondary.                                                                                      |
| Runtime                | Node.js 20 LTS                | Bun                        | node-pty native addon incompatibility risk                                                                                     |
| Package manager        | pnpm                          | npm/yarn                   | pnpm workspaces are superior for monorepos. Strict by default.                                                                 |
| Serialization          | JSON                          | MessagePack                | JSON is simpler, debuggable. Mini program WebSocket supports text frames natively. Performance not a bottleneck at this scale. |
| Build tool             | tsup                          | Rollup/Webpack             | Overkill for library/CLI bundling. tsup is zero-config.                                                                        |
| Schema validation      | zod                           | io-ts / ajv                | zod has best TypeScript inference. De facto standard for TS projects.                                                          |

## Key Version Constraints

| Package       | Min Version | Reason                                                                 |
| ------------- | ----------- | ---------------------------------------------------------------------- |
| Node.js       | 20          | LTS. node-pty requires Node 16+, but 20 gives us modern features.      |
| Feishu client | 7.39.0+     | Required for `tt.connectSocket` WebSocket API in mini programs         |
| Taro          | 3.1+        | Required for `@tarojs/plugin-platform-lark` Feishu compilation support |

## Installation

# Initialize monorepo

# (create pnpm-workspace.yaml with packages/\*)

# Shared

# Proxy

# Relay

# Feishu Mini Program

# Dev dependencies (root)

## Existing Prior Art

| Project                                                | Approach                                 | Language   | Notes                                                                              |
| ------------------------------------------------------ | ---------------------------------------- | ---------- | ---------------------------------------------------------------------------------- |
| [cc-connect](https://github.com/chenhg5/cc-connect)    | Multi-agent orchestrator with IM bridges | Go         | Feishu via WebSocket long-connection. Supports 7 agents. More complex than needed. |
| [Claude-to-IM](https://github.com/op7418/Claude-to-IM) | Bridge library with adapter pattern      | TypeScript | Has Feishu adapter. Host-agnostic DI design.                                       |

## Risk Register

| Risk                                        | Severity | Mitigation                                                                      |
| ------------------------------------------- | -------- | ------------------------------------------------------------------------------- |
| Taro + Feishu gadget compatibility issues   | MEDIUM   | Prototype Feishu compilation in Phase 1. Have native fallback plan.             |
| node-pty build failures on user machines    | MEDIUM   | Provide prebuilt binaries. Document build prerequisites (Python, C++ compiler). |
| Feishu mini program WebSocket limit (max 5) | LOW      | Only need 1 WebSocket to relay. Use multiplexing over single connection.        |
| strip-ansi ESM-only (v7+)                   | LOW      | Project uses TypeScript with ESM output. No CJS concerns.                       |

## Sources

- [Claude Code CLI Reference](https://code.claude.com/docs/en/cli-reference) -- HIGH confidence
- [Claude Code Headless Mode](https://code.claude.com/docs/en/headless) -- HIGH confidence
- [node-pty GitHub](https://github.com/microsoft/node-pty) -- HIGH confidence
- [ws npm](https://www.npmjs.com/package/ws) -- HIGH confidence, v8.20.0
- [Feishu connectSocket API](https://open.feishu.cn/document/uYjL24iN/ugDMx4COwEjL4ATM) -- HIGH confidence
- [Taro Documentation](https://docs.taro.zone/en/docs/) -- MEDIUM confidence
- [Feishu Taro Plugin Guide](https://open.feishu.cn/document/tools-and-resources/development-tools/develop-gadget-with-taro) -- MEDIUM confidence (terminology confusion between "gadget" and "mini program")
- [NutUI React Taro](https://www.npmjs.com/package/@nutui/nutui-react-taro) -- MEDIUM confidence
- [cc-connect](https://github.com/chenhg5/cc-connect) -- prior art reference
- [Claude-to-IM](https://github.com/op7418/Claude-to-IM) -- prior art reference
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

### Terminology

| Term         | Meaning                                                                                                      | Code Location                |
| ------------ | ------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| **terminal** | Local terminal process — wraps Claude Code CLI via PTY, holds TerminalTracker, runs on user's computer       | `apps/proxy/src/terminal.ts` |
| **serve**    | Local daemon process — IPC server, connects to relay, forwards frames and messages                           | `apps/proxy/src/serve.ts`    |
| **proxy**    | terminal + serve as a whole — the local side of CC Anywhere                                                  | `apps/proxy/`                |
| **relay**    | Cloud relay server — bridges proxy and client via WebSocket                                                  | `apps/relay/`                |
| **client**   | Web SPA — the remote viewer/controller (desktop browser or mobile PWA), connects to relay `/client` endpoint | `apps/web/`                  |

- "client" exclusively refers to the Web SPA, never the local terminal process
- When discussing the local terminal-attached process, use "terminal" not "client"
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.

<!-- GSD:architecture-end -->

## Development

### Web SPA 本地开发

```bash
pnpm --filter @cc-anywhere/web run dev      # Vite dev server, http://localhost:5173
pnpm --filter @cc-anywhere/web run build    # 生产构建到 apps/web/dist
pnpm --filter @cc-anywhere/web test:e2e     # Playwright E2E（需要 relay + proxy 在线）
```

路由用 hash 模式，直接访问：

- `/#/` — Proxy 选择页
- `/#/chat/:sessionId?mode=pty|json` — 聊天页

模拟手机分辨率：Chrome DevTools 中按 `Cmd+Shift+M` 打开设备工具栏，设置 390x844。

### 云端部署 (relay + web + nginx)

现行部署路径是 **tag-release + GHCR 预构建镜像**，`scripts/install-relay.sh --ssh` 到 VPS 秒起容器。`apps/relay/deploy.sh` 是老的 rsync + 远端构建方式，保留但不用。

**发版**：

```bash
# 1. bump 两个包的 version（apps/proxy/package.json + apps/relay/package.json）
# 2. commit + tag + push，触发 .github/workflows/release.yml
git tag v0.0.X && git push origin main v0.0.X
```

Workflow 会构建 `cc-anywhere-relay` 和 `cc-anywhere-web` 双镜像推 GHCR（`ghcr.io/lichenxicatapple-blip/`），同时发 npm。

**部署到 VPS**：

```bash
# SSH alias 'vita' 对应生产 VPS (cc-anywhere.vita-tools.top)
IMAGE_TAG=0.0.X ./scripts/install-relay.sh --ssh vita cc-anywhere.vita-tools.top
```

脚本做的事: 装 Docker → certbot 申 SSL（`/etc/letsencrypt/live/relay`）→ 写 `/opt/cc-anywhere/docker-compose.yml` + `.env`（`RELAY_PROXY_TOKEN` 复用已有）→ `docker compose pull && up` → 公网连通性验证。

**国内 VPS 加速**：默认拉 `ghcr.io/lichenxicatapple-blip/`，国内偶尔慢但能通。Aliyun ACR 镜像（`REGISTRY_BASE=registry.cn-hangzhou.aliyuncs.com/lichenxicatapple-blip`）理论更快但**需要 VPS 端先 `docker login` ACR 提供凭证**，一次性手工登录后持久化到 `~/.docker/config.json`。GHA workflow 会双推 GHCR + ACR（前提是 `ACR_USERNAME/NAMESPACE/REGISTRY/PASSWORD` 四个 secrets 都配了）。

**路径分流** (nginx.conf): `/proxy`, `/client` → relay WS; `/fonts`, `/health`, `/status`, `/api/*` → relay HTTP; 其他 → web SPA (hash 路由, SPA fallback 回 `index.html`)。

**鉴权**: `/proxy` 需要 `?token=<RELAY_PROXY_TOKEN>`, `/client` 开放。install-relay.sh 首次部署时生成 token, 之后复用 `/opt/cc-anywhere/.env` 里的。

**本地 proxy 连云端 relay**（手动切配置）：

```bash
# ~/.cc-anywhere/config.json:
# {"relayUrl": "wss://cc-anywhere.vita-tools.top", "relayToken": "<token-from-vps-env>"}
pnpm --filter @lichenxi.cat/cc-anywhere run serve restart
```

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.

<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.

<!-- GSD:profile-end -->
