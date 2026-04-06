<!-- GSD:project-start source:PROJECT.md -->
## Project

**CC Anywhere**

CC Anywhere 是 Claude Code 的透明代理和远程控制系统。它在本地包装 Claude Code CLI 进程，保持终端体验完全一致，同时通过中转服务器将会话桥接到飞书小程序，让用户在手机上也能像在电脑前一样与 Claude Code 实时交互。面向开发者的开源工具。

**Core Value:** 在任何地方（电脑或手机）都能与 Claude Code 实时交互，体验一致，不丢失上下文。

### Constraints

- **Tech Stack**: TypeScript -- 前后端统一，与 Claude Code 同技术栈
- **Runtime**: 本地代理运行在用户电脑上，中转服务器需要公网可访问
- **Platform**: 飞书小程序作为移动端入口
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
| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| `node-pty` | ^1.1.0 | Local transparent terminal wrapping | Microsoft-maintained. Used by VS Code terminal. Only library providing real PTY on Node.js. | HIGH |
| Claude Code CLI (`claude --stream-json`) | latest | Remote programmatic control via JSON event stream | No SDK dependency. cc-connect validated approach. Immune to SDK API churn. | HIGH |
### Core: Runtime & Language
| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Node.js | >=20 LTS | Runtime | Required by node-pty. LTS for stability. Matches Claude Code's own runtime. | HIGH |
| TypeScript | ^5.5 | Language | Project constraint. Full-stack consistency. | HIGH |
| pnpm | ^9.x | Package manager | Monorepo workspace support. Faster than npm. Strict dependency resolution prevents phantom deps. | HIGH |
### Core: Relay Server
| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| `ws` | ^8.20.0 | WebSocket server & client | Most popular Node.js WebSocket library. Lightweight, fast, well-tested. Used by 60k+ npm packages. No unnecessary abstraction over the protocol. | HIGH |
| `zod` | ^3.24 | Message schema validation | TypeScript-first runtime validation. Shared schemas between proxy, relay, and mini program. Prevents protocol drift. | HIGH |
| `express` or `fastify` | express ^4.21 / fastify ^5.x | HTTP server for health checks, session API | Lightweight HTTP alongside WebSocket. Express for simplicity; Fastify if performance matters. | HIGH |
### Core: Feishu Mini Program
| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Taro | ^4.1.11 | Cross-platform mini program framework | Official Feishu plugin exists (`@tarojs/plugin-platform-lark`). React + TypeScript support. Well-maintained by JD.com team. | MEDIUM |
| React | ^18.x | UI framework (via Taro) | Team familiarity. Better TypeScript support than Vue. Taro's React support is mature. | HIGH |
| `@nutui/nutui-react-taro` | ^3.x | UI component library | JD's official Taro-compatible React component library. Covers common mobile UI patterns. | MEDIUM |
### Supporting Libraries
| Library | Version | Purpose | Confidence |
|---------|---------|---------|------------|
| `strip-ansi` | ^7.2.0 | Strip ANSI escape codes from terminal output for logging/display | HIGH |
| `nanoid` | ^5.x | Generate compact, URL-safe unique IDs for sessions/messages | HIGH |
| `reconnecting-websocket` | ^4.4.0 | Auto-reconnecting WebSocket client wrapper (for proxy->relay connection) | HIGH |
| `pino` | ^9.x | Structured JSON logging for relay server | HIGH |
| `commander` | ^12.x | CLI argument parsing for local proxy | HIGH |
| `dotenv` | ^16.x | Environment variable management | HIGH |
| `vitest` | ^2.x | Testing framework | HIGH |
### Build & Development
| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| `tsup` | ^8.x | Bundle TypeScript for proxy CLI and relay server | Zero-config, esbuild-powered. Fast builds. Note: tsup maintenance has slowed; tsdown is the successor but not yet mature enough. | MEDIUM |
| `tsx` | ^4.x | TypeScript execution for development | Faster than ts-node. Uses esbuild. | HIGH |
| `eslint` | ^9.x | Linting with flat config | Standard. | HIGH |
| `prettier` | ^3.x | Code formatting | Standard. | HIGH |
### Infrastructure
| Technology | Purpose | Why | Confidence |
|------------|---------|-----|------------|
| Docker | Relay server containerization | Standard deployment. Single Dockerfile for the relay. | HIGH |
| Nginx (optional) | TLS termination, reverse proxy | Only if relay needs HTTPS/WSS in front. | MEDIUM |
## Monorepo Structure
## Alternatives Considered
| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Claude Code interface | node-pty + stream-json (dual) | PTY-only with ANSI parsing | Fragile parsing of terminal UI. Breaks on Claude Code updates. |
| Claude Code interface | node-pty + stream-json (dual) | Agent SDK | Unstable v0.2.x API, unnecessary dependency when CLI stream-json provides the same capability. |
| WebSocket | ws | Socket.IO | Over-engineered. We control both ends. |
| WebSocket | ws | uWebSockets.js | Premature optimization for personal-scale tool |
| Mini program framework | Taro + React | Native Feishu TTML | Poor DX. No TypeScript-first support. Small ecosystem. |
| Mini program framework | Taro + React | uni-app | Vue-oriented. React support is secondary. |
| Runtime | Node.js 20 LTS | Bun | node-pty native addon incompatibility risk |
| Package manager | pnpm | npm/yarn | pnpm workspaces are superior for monorepos. Strict by default. |
| Serialization | JSON | MessagePack | JSON is simpler, debuggable. Mini program WebSocket supports text frames natively. Performance not a bottleneck at this scale. |
| Build tool | tsup | Rollup/Webpack | Overkill for library/CLI bundling. tsup is zero-config. |
| Schema validation | zod | io-ts / ajv | zod has best TypeScript inference. De facto standard for TS projects. |
## Key Version Constraints
| Package | Min Version | Reason |
|---------|-------------|--------|
| Node.js | 20 | LTS. node-pty requires Node 16+, but 20 gives us modern features. |
| Feishu client | 7.39.0+ | Required for `tt.connectSocket` WebSocket API in mini programs |
| Taro | 3.1+ | Required for `@tarojs/plugin-platform-lark` Feishu compilation support |
## Installation
# Initialize monorepo
# (create pnpm-workspace.yaml with packages/*)
# Shared
# Proxy
# Relay
# Feishu Mini Program
# Dev dependencies (root)
## Existing Prior Art
| Project | Approach | Language | Notes |
|---------|----------|----------|-------|
| [cc-connect](https://github.com/chenhg5/cc-connect) | Multi-agent orchestrator with IM bridges | Go | Feishu via WebSocket long-connection. Supports 7 agents. More complex than needed. |
| [Claude-to-IM](https://github.com/op7418/Claude-to-IM) | Bridge library with adapter pattern | TypeScript | Has Feishu adapter. Host-agnostic DI design. |
## Risk Register
| Risk | Severity | Mitigation |
|------|----------|------------|
| Taro + Feishu gadget compatibility issues | MEDIUM | Prototype Feishu compilation in Phase 1. Have native fallback plan. |
| node-pty build failures on user machines | MEDIUM | Provide prebuilt binaries. Document build prerequisites (Python, C++ compiler). |
| Feishu mini program WebSocket limit (max 5) | LOW | Only need 1 WebSocket to relay. Use multiplexing over single connection. |
| strip-ansi ESM-only (v7+) | LOW | Project uses TypeScript with ESM output. No CJS concerns. |
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

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

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
