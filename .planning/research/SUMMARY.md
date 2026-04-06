# Project Research Summary

> **[SUPERSEDED]** 本文档中关于 Agent SDK (`@anthropic-ai/claude-agent-sdk`) 的推荐已过时。Phase 3 决定采用 `claude --stream-json` CLI 方案替代 Agent SDK，参见 `.planning/phases/03-local-proxy-service-multi-session/03-CONTEXT.md` D-05/D-06。

**Project:** CC Anywhere
**Domain:** CLI transparent proxy + WebSocket relay + Feishu mini program (remote Claude Code control)
**Researched:** 2026-04-03
**Confidence:** MEDIUM-HIGH

## Executive Summary

CC Anywhere is a personal-scale remote control tool that lets a developer interact with Claude Code running on their local machine from a Feishu mini program. Research reveals the correct architecture is a three-tier system: a local proxy that wraps Claude Code via the Agent SDK, a public relay server that routes messages between proxy and mobile client, and a Feishu mini program as the remote interface. The single most consequential architectural decision is how the proxy interfaces with Claude Code. Using raw PTY output forwarding is the obvious-but-wrong approach — Claude Code's Ink-based TUI emits 4,000-6,700 screen redraws per second during streaming, producing ~189 KB/sec of ANSI escape codes that would saturate WebSocket and freeze the mobile client. The correct approach is the Agent SDK for the relay channel and node-pty only for transparent local terminal pass-through. This dual-mode design is validated by prior art (Claude-to-IM adapter pattern) and eliminates the ANSI parsing problem entirely.

The recommended stack centers on `@anthropic-ai/claude-agent-sdk` (v0.2.x, pinned at exact version) for structured Claude Code control, `node-pty` for transparent local terminal experience, `ws` for WebSocket transport, `zod` for shared protocol schemas across a pnpm monorepo, and Taro + React for the Feishu mini program. The Agent SDK provides structured `SDKMessage` events, a `canUseTool` callback for async tool approval (the SDK blocks execution until the callback resolves — this maps directly to remote approval via Feishu), `AsyncGenerator<SDKUserMessage>` for streaming multi-turn input from both local stdin and Feishu, and built-in session management. The shared package containing zod protocol schemas is the contract between all three runtime components and must be established first.

The top risks are Agent SDK API instability (v0.2.x is actively evolving, recently renamed), Taro-Feishu compatibility (official documentation is ambiguous about "gadget" vs "mini program"), and orphaned Claude Code processes (production incident data shows 48 orphaned processes consuming 2.3 GB after 17 hours of missed cleanup). All three have clear mitigations: pin exact SDK version behind an adapter interface, prototype Feishu compilation in Phase 1 planning, and implement process lifecycle management alongside session creation, not later. The critical path is: transparent proxy -> relay server -> Feishu mini program -> bidirectional messaging -> tool call approval.

## Key Findings

### Recommended Stack

The monorepo has four packages: `shared` (zod protocol schemas and types), `proxy` (Agent SDK + node-pty + WS client), `relay` (WS server + HTTP REST API), and `feishu` (Taro + React mini program). pnpm workspaces connect them. The shared package is the protocol contract — every message type between all three runtime components is defined there with zod, providing end-to-end type safety. The Feishu mini program cannot directly import npm packages at runtime, so shared types must be inlined at build time.

The Agent SDK is the correct primary interface for Claude Code programmatic control. PTY spawning via `child_process.spawn()` has a documented bug where Claude Code hangs in Node.js — the SDK works around this internally. Socket.IO is overengineered for this use case since we control both ends of the WebSocket connection. Bun is not viable because node-pty is a native C++ addon with incomplete Bun support.

**Core technologies:**
- ~~`@anthropic-ai/claude-agent-sdk` ^0.2.90~~ **[已替换]** 改用 `claude --stream-json` CLI 方案 — 通过 CLI 子进程获取结构化 JSON 流输出，避免 SDK 版本不稳定问题
- `node-pty` ^1.1.0: Local terminal transparency — byte-for-byte PTY pass-through for the user sitting at the machine
- `ws` ^8.20.0: WebSocket transport — lightweight, no unnecessary abstraction, we control both ends
- `zod` ^3.24: Protocol schema validation — shared between proxy, relay, and mini program at build time
- Taro ^4.1.11 + `@tarojs/plugin-platform-lark` + React ^18: Feishu mini program — React + TypeScript compiled to Feishu gadget
- Node.js >=20 LTS: Runtime — required by node-pty native addon; Bun is not viable
- pnpm ^9.x: Package manager — monorepo workspaces, strict dependency resolution

**Critical version constraints:**
- Feishu client >= 7.39.0 for `tt.connectSocket` WebSocket API
- Taro >= 3.1 for `@tarojs/plugin-platform-lark` Feishu compilation support
- `@anthropic-ai/claude-agent-sdk`: pin exact minor version, not `^`

### Expected Features

The feature dependency chain defines the critical path. The transparent CLI proxy is the hardest table-stakes feature and must come first. Tool call approval from mobile is the core "walk away from desk" use case — without it, the product has no unique value over just SSH. Full terminal emulation in the mini program is an explicit anti-feature: xterm.js on mobile is unusable, and Claude Code's Ink TUI cannot be meaningfully replicated; the correct approach is parsing semantic content and rendering native mobile components.

**Must have (table stakes):**
- Transparent CLI proxy — users at desktop must see zero behavioral difference from native Claude Code
- Real-time bidirectional messaging — streaming output and input, not polling
- Relay server with NAT traversal — outbound WebSocket from proxy to public relay, no inbound ports needed
- Tool call approval from mobile — approve/deny with timeout and deadlock prevention
- Multi-session management — create, list, switch, terminate sessions from mobile
- Session persistence and history — reconnect without losing context
- Connection resilience — auto-reconnect with exponential backoff, message queuing during gaps
- Basic mobile output rendering — readable code blocks and text, not raw terminal dump

**Should have (competitive differentiators):**
- Feishu-native mini program UI — proper mini program vs bot message cards (no competitor does this)
- Dual-surface operation — terminal and mobile simultaneously, state synchronized
- Smart output rendering — parse Claude's structured output into mobile-appropriate components
- Push notifications via Feishu subscribe messages — alert when Claude needs approval or finishes
- Quick actions / preset commands — one-tap common commands reduce mobile typing friction
- Session naming and cost/usage tracking — UX polish, developers care about token costs

**Defer to v2+:**
- Full terminal emulator in mini program (anti-feature)
- Multi-user / group collaboration
- Web UI (official Remote Control already covers this)
- OAuth / multi-user auth system
- Custom model routing / API proxying
- Automated task scheduling

### Architecture Approach

The architecture follows a three-tier relay pattern. The proxy owns session state; the relay is a dumb message router that buffers recent messages for reconnection. This is intentional — if the relay restarts, sessions survive because the proxy and SDK hold the actual state. All WebSocket communication uses a typed `MessageEnvelope` protocol with monotonically increasing sequence numbers to enable message replay on reconnection. The `canUseTool` SDK callback creates a Promise that blocks SDK execution until the relay delivers an `approval.response`, implementing remote tool approval without polling. Both local stdin and Feishu input are serialized into a single `AsyncGenerator` fed to the SDK to prevent race conditions.

**Major components:**
1. **Local Proxy** (`packages/proxy`) — Wraps Claude Code via Agent SDK, routes SDK events to both local terminal renderer and relay WS client, serializes input from local stdin and Feishu into single `AsyncGenerator` fed to SDK; owns session state
2. **Relay Server** (`packages/relay`) — WebSocket gateway for proxies and mini program clients, message router with per-session buffer (last N messages with TTL), REST API for session list and history queries; stateless message router, not session owner
3. **Session Store** — SQLite or JSONL files on relay server for message history; proxy can resume via SDK's built-in session persistence
4. **Feishu Mini Program** (`packages/feishu`) — Session list page, chat/conversation page, tool approval dialog; single multiplexed WebSocket to relay; custom output renderer for code blocks and markdown

**Key patterns:**
- Agent SDK streaming input via `AsyncGenerator<SDKUserMessage>` as the bidirectional control channel
- `MessageEnvelope` protocol with typed `MessageType` union across all WS communication
- Dual-source input arbitration: serialize local and remote inputs, first approval response wins
- Proxy as session owner, relay as message buffer only

### Critical Pitfalls

1. **TUI redraw flood over WebSocket** — Claude Code's Ink renderer produces ~189 KB/sec of ANSI escape codes. Never forward raw PTY output to the relay. Use Agent SDK for the relay channel from day one. This is a Phase 1 architecture decision — wrong choices here require full pipeline rewrites.

2. **Orphaned Claude Code processes** — Missed cleanup causes processes to accumulate silently; production data shows 48 processes / 2.3 GB after 17 hours. Implement process lifecycle management alongside session creation: process registry with creation timestamps, SIGTERM -> SIGKILL after 5-second grace period, `query.close()` on SDK sessions, periodic reaper every 60s, heartbeat-triggered cleanup.

3. **WebSocket reconnection without state recovery** — Mobile networks drop frequently. Messages sent during disconnection are permanently lost without sequence numbers and server-side replay. Design sequence numbers into the relay protocol from day one; they are cheap to add early and expensive to retrofit.

4. **Tool call approval deadlock** — The SDK's `canUseTool` callback blocks execution. If the mobile user disconnects with a pending approval, the session hangs forever. Always implement a configurable timeout (default 5 minutes, deny on expiry) and a pending-approval queue with unique IDs. On reconnect, replay pending approval requests.

5. **Agent SDK version instability** — v0.2.x has breaking changes and was recently renamed from `@anthropic-ai/claude-code`. Pin exact version (no `^`) and wrap all SDK calls behind a thin adapter interface. Only the adapter changes on SDK upgrades.

6. **Feishu mini program platform gaps** — Real device behavior diverges significantly from the simulator for WebSocket APIs. Set up real device debugging from Phase 3 start. Multiplex all sessions over one WebSocket connection to avoid the 5-connection limit. App backgrounding silently disconnects WebSocket — implement heartbeat pings.

7. **Transparent proxy terminal breakage** — SIGWINCH, raw mode, signal propagation, and alternate screen buffer all require explicit handling. Read parent terminal size on startup and relay SIGWINCH. Set parent terminal to raw mode and pipe stdin directly to PTY. Never parse or modify the byte stream in the local terminal path.

## Implications for Roadmap

Build order follows clear dependency constraints: the shared protocol package must exist before relay or mini program code can be written; the relay must exist before the mini program can be meaningfully tested; resilience and polish are possible only after the full end-to-end pipeline is proven. Each phase produces a testable artifact.

### Phase 1: Local Proxy and Shared Protocol

**Rationale:** The proxy has the highest concentration of critical pitfalls (1, 2, 3, 5, 6, 8 from PITFALLS.md all land here). Resolving these risks first prevents expensive rewrites. The shared package must exist before relay or mini program can be built. Getting dual-mode architecture wrong means rewriting the entire message pipeline.

**Delivers:** A working enhanced Claude Code wrapper. Running `cc-anywhere` instead of `claude` is transparent locally, with structured session events logged internally. No remote features yet, but the foundation for everything is correct and proven.

**Addresses:** Transparent CLI proxy, Agent SDK integration, terminal transparency guarantee, shared protocol definition

**Avoids:** TUI redraw flood (dual-mode architecture established), orphaned processes (lifecycle management alongside creation), Agent SDK instability (adapter interface), transparent proxy breakage (PTY signal handling), UTF-8 corruption (StringDecoder on PTY output)

**Needs research:** Verify `@tarojs/plugin-platform-lark` current state against Taro 4.x before committing to mini program approach; decide Feishu vs Lark target (affects Phase 3 entirely); verify Agent SDK `canUseTool` callback behavior with real Claude Code sessions

### Phase 2: Relay Server and Protocol

**Rationale:** The relay depends on shared protocol types from Phase 1. It can be built and tested with mock proxy clients. Sequence numbers and message replay must be designed into the protocol now — the technical debt table in PITFALLS.md explicitly flags this as "never acceptable as a shortcut."

**Delivers:** Deployed relay server with WebSocket gateway, session registry, message buffer with sequence numbers and TTL, REST API for history. Proxy connects to relay and forwards session events. End-to-end flow works without mobile client using WebSocket inspection tools.

**Uses:** `ws`, `zod`, `pino`, `nanoid`, `express` or `fastify`, SQLite or JSONL session store, Docker for deployment

**Implements:** Relay server component, proxy WS client (bridge.ts), approval request/response round-trip with timeout, `MessageEnvelope` protocol with sequence numbers

**Avoids:** Message loss on reconnection (sequence numbers + replay), approval deadlock (timeout implementation), relay as state owner (proxy owns state)

**Standard patterns:** WebSocket relay, message buffering, exponential backoff — skip research-phase

### Phase 3: Feishu Mini Program

**Rationale:** The mini program depends on a running relay. Feishu-specific pitfalls are isolated to this phase, so they don't block earlier work. However, the Feishu vs Lark decision and domain whitelist configuration must be made in Phase 1 planning, not discovered here.

**Delivers:** Working Feishu mini program with session list, conversation view, tool approval dialogs, and real-time bidirectional messaging. Completes the end-to-end flow.

**Uses:** Taro ^4.1.11, `@tarojs/plugin-platform-lark`, React ^18, `@nutui/nutui-react-taro`

**Implements:** Feishu mini program component, custom output renderer (markdown, code blocks, tool call cards), single multiplexed WebSocket to relay, approval dialog with pending state

**Avoids:** Feishu platform constraints (real device from day one, single WS connection, heartbeat pings), Taro compilation issues (prototype complex rendering components before committing)

**Needs research:** Feishu app review requirements and timeline; verify Taro `@tarojs/plugin-platform-lark` compilation against current Feishu client; prototype chat stream rendering to validate component library choices; Feishu M-chip developer tools Rosetta requirement

### Phase 4: Usability and Resilience

**Rationale:** The core pipeline works end-to-end after Phase 3. This phase hardens it for real-world use. Session persistence, connection resilience, and smart output rendering make the product usable for extended sessions rather than just demos.

**Delivers:** Auto-reconnect with message replay, session history persistence, smart output rendering (parse structured Claude output into mobile-friendly components), full multi-session management from mobile

**Addresses:** Session persistence, connection resilience, smart output rendering, multi-session management, dual-surface operation

**Standard patterns:** Exponential backoff, SQLite persistence, markdown rendering — skip research-phase

### Phase 5: Polish

**Rationale:** Notification system, quick actions, session naming, and cost tracking are high-value UX improvements that don't affect core correctness. Defer until the pipeline is proven and stable.

**Delivers:** Push notifications when Claude needs approval or finishes (Feishu subscribe messages), one-tap quick actions, session naming and organization, token usage and time tracking

**Addresses:** Notification system, quick actions, session naming/organization, cost/usage tracking

**May need brief research:** Feishu subscribe message permissions and review requirements for notification features

### Phase Ordering Rationale

- Shared protocol first: it is the contract all three runtime components depend on
- Proxy before relay: relay protocol is informed by what the proxy actually emits
- Relay before mini program: mini program needs a running relay to test against; building in isolation causes integration surprises
- Resilience after full pipeline: you cannot meaningfully test reconnection behavior without all three components running end-to-end
- Polish last: no dependencies on future work, high value, zero risk to core correctness

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 1:** Verify exact Agent SDK v0.2.x API for `canUseTool`, streaming input, and `query.close()` — SDK is evolving and docs may lag; prototype dual-mode coexistence (PTY + SDK on same session)
- **Phase 3:** Resolve Feishu "gadget" vs "mini program" terminology before writing any code; verify `@tarojs/plugin-platform-lark` with current Taro and Feishu client versions; determine Feishu app review process and timeline

Phases with standard patterns (skip research-phase):
- **Phase 2:** WebSocket relay with message buffering and sequence numbers is extensively documented
- **Phase 4:** Exponential backoff, state replay, SQLite persistence — standard patterns
- **Phase 5:** Feishu subscribe messages have official API documentation; may need one-day check on notification permission requirements

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | MEDIUM-HIGH | Core stack (Node.js, ws, zod, TypeScript, pnpm) is HIGH. Agent SDK at MEDIUM due to v0.2.x instability. Taro + Feishu at MEDIUM due to "gadget" vs "mini program" terminology confusion in official docs. |
| Features | HIGH | Official Claude Code Remote Control docs provide complete competitive context. Feature set is well-defined with clear precedent from competing products. Feishu mini program platform constraints at MEDIUM (sparse official docs, extrapolated from ByteDance/WeChat norms). |
| Architecture | HIGH | Based on official Agent SDK documentation. Dual-mode design validated by Claude-to-IM prior art. Three-tier relay pattern is industry standard. Anti-patterns documented with concrete production incident data (GitHub issues with reproduction numbers). |
| Pitfalls | HIGH (PTY/WS) / MEDIUM (Feishu) | PTY and WebSocket pitfalls sourced from concrete GitHub issues with quantified reproduction data. Feishu mini program pitfalls extrapolated from WeChat mini program platform norms due to sparse Feishu-specific documentation. |

**Overall confidence:** MEDIUM-HIGH

### Gaps to Address

- **Feishu "gadget" vs "mini program" terminology:** Official Feishu docs use both terms and one Taro guide is labeled "Not Recommended." Must verify which compilation path (`@tarojs/plugin-platform-lark`) produces the correct artifact before any mini program code is written. Prototype in Phase 1 planning.

- **Agent SDK dual-mode validation:** Can the Agent SDK run alongside a PTY-wrapped Claude Code instance for the same session without conflicts? The STACK.md recommends dual-mode but notes this adds complexity. Prototype required.

- **Agent SDK V2 preview:** The SDK has a V2 interface preview with `send()` and `stream()` patterns. Should v1 target stable V1 or the preview V2? V2 may be more suitable but is in preview. Evaluate before finalizing the adapter interface.

- **Feishu app review requirements:** Unknown review timeline and policy requirements. Could gate Phase 3 completion by days or weeks. Investigate in Phase 1 to avoid schedule surprises.

- **Feishu vs Lark platform choice:** API availability may differ between China (feishu.cn) and international (lark) versions. Explicitly target one for v1. Affects which developer tools to use and which APIs are accessible.

- **node-pty build prerequisites on target machines:** The proxy is a CLI tool users install. node-pty requires a C++ compiler and Python. Must document prerequisites or provide prebuilt binaries to avoid install failures at distribution time.

## Sources

### Primary (HIGH confidence)
- [Claude Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) — SDK API, canUseTool, streaming, session management
- [Claude Agent SDK Streaming Output](https://platform.claude.com/docs/en/agent-sdk/streaming-output) — SDKMessage types, event structure
- [Claude Agent SDK Migration Guide](https://platform.claude.com/docs/en/agent-sdk/migration-guide) — breaking change history, package rename
- [Claude Code Headless Mode](https://code.claude.com/docs/en/headless) — programmatic usage, output formats
- [Claude Code Remote Control docs](https://code.claude.com/docs/en/remote-control) — competitive feature reference, official feature set
- [Claude Code Channels Reference](https://code.claude.com/docs/en/channels-reference) — channel plugin architecture, permission relay protocol
- [node-pty GitHub](https://github.com/microsoft/node-pty) — PTY behavior, threading, resize handling
- [ws npm package](https://www.npmjs.com/package/ws) — WebSocket server/client API, v8.20.0
- [Feishu connectSocket API](https://open.feishu.cn/document/uYjL24iN/ugDMx4COwEjL4ATM) — 5-connection limit, WebSocket API
- [Claude Code Issue #9935](https://github.com/anthropics/claude-code/issues/9935) — 4,000-6,700 scroll events/sec, ~189 KB/sec ANSI data
- [Node.js UTF-8 bug #61744](https://github.com/nodejs/node/issues/61744) — partial UTF-8 write corruption

### Secondary (MEDIUM confidence)
- [Taro Documentation](https://docs.taro.zone/en/docs/) — Feishu plugin, React support
- [Feishu Taro Plugin Guide](https://open.feishu.cn/document/tools-and-resources/development-tools/develop-gadget-with-taro) — compilation target, "Not Recommended" label ambiguity
- [Claude-to-IM (prior art)](https://github.com/op7418/Claude-to-IM) — validates Agent SDK adapter pattern; TypeScript, Feishu adapter
- [cc-connect (prior art)](https://github.com/chenhg5/cc-connect) — validates Feishu WS long connection approach; Go, multi-agent
- [feishu-claude-code](https://github.com/joewongjc/feishu-claude-code) — competing approach (no terminal transparency, Python subprocess)
- [WebSocket relay architecture best practices](https://ably.com/topic/websocket-architecture-best-practices) — relay patterns

### Tertiary (LOW-MEDIUM confidence)
- [SessionCast](https://sessioncast.io/) — competitive analysis, terminal streaming via xterm.js (anti-feature reference)
- [claude-push](https://dev.to/coa00/how-i-built-a-mobile-approval-system-for-claude-code-so-i-can-finally-leave-my-desk-1ida) — mobile approval system using hooks + ntfy.sh (validates approval use case)
- [Harper Reed's blog](https://harper.blog/2026/01/05/claude-code-is-better-on-your-phone/) — SSH/tmux/Tailscale DIY approach (validates mobile use case)
- [NutUI React Taro](https://www.npmjs.com/package/@nutui/nutui-react-taro) — UI component library candidate for mini program

---
*Research completed: 2026-04-03*
*Ready for roadmap: yes*
