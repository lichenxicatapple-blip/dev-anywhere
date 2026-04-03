# Technology Stack

**Project:** CC Anywhere
**Researched:** 2026-04-03
**Overall confidence:** MEDIUM-HIGH

## Critical Architecture Decision: Agent SDK vs PTY Wrapping

The single most important stack decision is **how to interface with Claude Code**.

The project description says "wrap the Claude Code CLI process with PTY." However, research reveals that the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) now provides a first-class TypeScript API that offers:

- Structured streaming output (text deltas, tool calls, status messages)
- `canUseTool` callback for programmatic tool approval
- Multi-turn conversation via `streamInput()` async iterable
- Session management (list, resume, rename, tag)
- AbortController support for cancellation

**Recommendation: Dual-mode architecture.**

1. **Agent SDK** (`@anthropic-ai/claude-agent-sdk`) as the primary programmatic interface for remote control via Feishu. This gives structured, machine-parseable events.
2. **node-pty** for transparent local terminal wrapping only when the user wants to also see the session locally. The PTY output is forwarded to the local terminal as-is; the Agent SDK handles the Feishu bridge.

This avoids the nightmare of parsing raw ANSI terminal output for remote display while preserving the "transparent local proxy" requirement. The Agent SDK is the structured channel; the PTY is the passthrough channel.

**Confidence: MEDIUM** -- The Agent SDK is relatively new (v0.2.x) and evolving fast. The dual-mode approach adds complexity. If local terminal transparency is truly the top priority, a simpler PTY-only approach with ANSI-to-text conversion is the fallback.

---

## Recommended Stack

### Core: Claude Code Interface

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| `@anthropic-ai/claude-agent-sdk` | ^0.2.90 | Programmatic Claude Code control for remote sessions | First-party SDK. Provides structured streaming, tool approval callbacks, session management. Eliminates ANSI parsing. | MEDIUM |
| `node-pty` | ^1.1.0 | Local transparent terminal wrapping | Microsoft-maintained. Used by VS Code terminal. Only library providing real PTY on Node.js. | HIGH |

**Why not PTY-only:** Parsing raw ANSI escape sequences to extract structured information (tool calls, approval requests, text output) from terminal output is fragile and will break with every Claude Code UI update. The Agent SDK gives this for free.

**Why not Agent SDK-only:** The Agent SDK runs in headless mode (`-p` flag). It does not render the interactive terminal UI. Users who sit at their computer still want the native Claude Code terminal experience.

### Core: Runtime & Language

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Node.js | >=20 LTS | Runtime | Required by node-pty. LTS for stability. Matches Claude Code's own runtime. | HIGH |
| TypeScript | ^5.5 | Language | Project constraint. Full-stack consistency. | HIGH |
| pnpm | ^9.x | Package manager | Monorepo workspace support. Faster than npm. Strict dependency resolution prevents phantom deps. | HIGH |

**Why not Bun:** node-pty is a native C++ addon that requires node-gyp. Bun's native addon support is still incomplete. Node.js is the safe choice here.

### Core: Relay Server

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| `ws` | ^8.20.0 | WebSocket server & client | Most popular Node.js WebSocket library. Lightweight, fast, well-tested. Used by 60k+ npm packages. No unnecessary abstraction over the protocol. | HIGH |
| `zod` | ^3.24 | Message schema validation | TypeScript-first runtime validation. Shared schemas between proxy, relay, and mini program. Prevents protocol drift. | HIGH |
| `express` or `fastify` | express ^4.21 / fastify ^5.x | HTTP server for health checks, session API | Lightweight HTTP alongside WebSocket. Express for simplicity; Fastify if performance matters. | HIGH |

**Why not Socket.IO:** Over-engineered for this use case. We control both ends of the WebSocket connection. Socket.IO's auto-reconnection, rooms, namespaces add weight we don't need. Raw `ws` + our own reconnection logic is simpler and more predictable.

**Why not uWebSockets.js:** Premature optimization. We're handling at most dozens of concurrent connections (personal tool), not thousands. `ws` is fast enough and has a much better TypeScript developer experience.

### Core: Feishu Mini Program

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Taro | ^4.1.11 | Cross-platform mini program framework | Official Feishu plugin exists (`@tarojs/plugin-platform-lark`). React + TypeScript support. Well-maintained by JD.com team. | MEDIUM |
| React | ^18.x | UI framework (via Taro) | Team familiarity. Better TypeScript support than Vue. Taro's React support is mature. | HIGH |
| `@nutui/nutui-react-taro` | ^3.x | UI component library | JD's official Taro-compatible React component library. Covers common mobile UI patterns. | MEDIUM |

**Why Taro over native Feishu gadget development:** Feishu's native gadget framework uses a WeChat-like template syntax (TTML + TTSS). Taro lets us write React + TypeScript with the same mental model as the rest of the codebase. The official `@tarojs/plugin-platform-lark` compiles to Feishu gadgets. Feishu's docs explicitly describe Taro integration.

**Why not native Feishu development:** The native framework lacks TypeScript-first DX, has limited component ecosystem, and uses unfamiliar template syntax (TTML). Development would be slower and code wouldn't benefit from the existing TypeScript ecosystem.

**Risk: Feishu's docs label one Taro guide as "Not Recommended" for gadgets specifically, but their main mini program Taro integration guide is actively maintained.** The "gadget" vs "mini program" terminology in Feishu is confusing -- they appear to be converging these concepts. Need to verify during Phase 1 which path works.

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

---

## Monorepo Structure

```
cc-anywhere/
  packages/
    shared/          # Shared types, message schemas (zod), constants
    proxy/           # Local CLI proxy (node-pty + Agent SDK + WS client)
    relay/           # Relay server (WS server + HTTP API)
    feishu/          # Feishu mini program (Taro + React)
  pnpm-workspace.yaml
  tsconfig.base.json
```

Use pnpm workspaces. The `shared` package is critical -- it defines the message protocol schemas with zod, ensuring type safety across all three components.

---

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Claude Code interface | Agent SDK + node-pty (dual) | PTY-only with ANSI parsing | Fragile parsing of terminal UI. Breaks on Claude Code updates. |
| Claude Code interface | Agent SDK + node-pty (dual) | Agent SDK-only | Loses transparent local terminal experience |
| WebSocket | ws | Socket.IO | Over-engineered. We control both ends. |
| WebSocket | ws | uWebSockets.js | Premature optimization for personal-scale tool |
| Mini program framework | Taro + React | Native Feishu TTML | Poor DX. No TypeScript-first support. Small ecosystem. |
| Mini program framework | Taro + React | uni-app | Vue-oriented. React support is secondary. |
| Runtime | Node.js 20 LTS | Bun | node-pty native addon incompatibility risk |
| Package manager | pnpm | npm/yarn | pnpm workspaces are superior for monorepos. Strict by default. |
| Serialization | JSON | MessagePack | JSON is simpler, debuggable. Mini program WebSocket supports text frames natively. Performance not a bottleneck at this scale. |
| Build tool | tsup | Rollup/Webpack | Overkill for library/CLI bundling. tsup is zero-config. |
| Schema validation | zod | io-ts / ajv | zod has best TypeScript inference. De facto standard for TS projects. |

---

## Key Version Constraints

| Package | Min Version | Reason |
|---------|-------------|--------|
| Node.js | 20 | LTS. node-pty requires Node 16+, but 20 gives us modern features. |
| Feishu client | 7.39.0+ | Required for `tt.connectSocket` WebSocket API in mini programs |
| Taro | 3.1+ | Required for `@tarojs/plugin-platform-lark` Feishu compilation support |
| `@anthropic-ai/claude-agent-sdk` | 0.2.x | Breaking changes expected. Pin minor version. |

---

## Installation

```bash
# Initialize monorepo
pnpm init
# (create pnpm-workspace.yaml with packages/*)

# Shared
cd packages/shared
pnpm add zod nanoid

# Proxy
cd packages/proxy
pnpm add @anthropic-ai/claude-agent-sdk node-pty ws reconnecting-websocket commander strip-ansi pino
pnpm add -D @types/ws

# Relay
cd packages/relay
pnpm add ws zod pino nanoid
pnpm add -D @types/ws

# Feishu Mini Program
cd packages/feishu
npx @tarojs/cli init --template react-ts
pnpm add @tarojs/plugin-platform-lark @nutui/nutui-react-taro

# Dev dependencies (root)
pnpm add -D -w typescript tsup tsx vitest eslint prettier
```

---

## Existing Prior Art

Two existing open-source projects bridge Claude Code to Feishu:

| Project | Approach | Language | Notes |
|---------|----------|----------|-------|
| [cc-connect](https://github.com/chenhg5/cc-connect) | Multi-agent orchestrator with IM bridges | Go | Feishu via WebSocket long-connection. Supports 7 agents. More complex than needed. |
| [Claude-to-IM](https://github.com/op7418/Claude-to-IM) | Bridge library with adapter pattern | TypeScript | Wraps Claude Code SDK's streaming. Has Feishu adapter. Host-agnostic DI design. |

**Implication for CC Anywhere:** Claude-to-IM's adapter pattern validates the Agent SDK approach. CC Anywhere differentiates by adding transparent local terminal proxy + Feishu mini program (not just bot messages).

---

## Risk Register

| Risk | Severity | Mitigation |
|------|----------|------------|
| Agent SDK API churn (v0.2.x) | HIGH | Pin version. Wrap SDK calls in an adapter layer. Monitor changelogs. |
| Taro + Feishu gadget compatibility issues | MEDIUM | Prototype Feishu compilation in Phase 1. Have native fallback plan. |
| node-pty build failures on user machines | MEDIUM | Provide prebuilt binaries. Document build prerequisites (Python, C++ compiler). |
| Feishu mini program WebSocket limit (max 5) | LOW | Only need 1 WebSocket to relay. Use multiplexing over single connection. |
| strip-ansi ESM-only (v7+) | LOW | Project uses TypeScript with ESM output. No CJS concerns. |

---

## Sources

- [Claude Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) -- HIGH confidence
- [Claude Agent SDK Streaming](https://platform.claude.com/docs/en/agent-sdk/streaming-output) -- HIGH confidence
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
