# Roadmap: CC Anywhere

## Overview

CC Anywhere delivers a transparent Claude Code proxy with remote control via Feishu mini program. The build order follows strict dependency constraints: shared protocol and local proxy first (highest risk, foundation for everything), then relay server (transport layer), then Feishu mini program (mobile surface), then progressive enhancement layers (tool approval, rendering, voice, polish). Each phase produces a testable artifact that proves the next phase's foundation is solid.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Monorepo & Shared Protocol** - Project scaffolding, pnpm monorepo, zod message schemas shared across all packages
- [ ] **Phase 2: Local Proxy - PTY Transparency** - Transparent CLI wrapper that makes `cc-anywhere` indistinguishable from `claude`
- [ ] **Phase 3: Local Proxy - Service Architecture & Multi-Session** - Service+client architecture with stream-json remote control and multi-session lifecycle management
- [ ] **Phase 4: Relay Server - Core Transport** - WebSocket bridge with typed message protocol and sequence-numbered delivery
- [ ] **Phase 5: Relay Server - Resilience** - Auto-reconnect, message queuing during disconnection, and session state recovery
- [ ] **Phase 6: Feishu Mini Program - Core Interaction** - Send messages, see streaming output, manage sessions, view history
- [ ] **Phase 7: Tool Approval & Dual-Surface Sync** - Remote tool call approval from mobile and synchronized terminal+mobile operation
- [ ] **Phase 8: Output Rendering** - Mobile-friendly structured rendering: code blocks, markdown, syntax highlighting, diff display
- [ ] **Phase 9: Voice Input** - Speech-to-text input in Feishu mini program
- [ ] **Phase 10: Notifications, Quick Actions & Session Polish** - Push notifications, preset commands, session naming, status labels, usage tracking

## Phase Details

### Phase 1: Monorepo & Shared Protocol
**Goal**: All packages share a single source of truth for message types and protocol schemas
**Depends on**: Nothing (first phase)
**Requirements**: None (infrastructure foundation)
**Success Criteria** (what must be TRUE):
  1. Running `pnpm install` from repo root sets up all four packages (shared, proxy, relay, feishu) with correct cross-references
  2. Changing a message type in `packages/shared` causes type errors in dependent packages at compile time
  3. MessageEnvelope schema with sequence numbers, session IDs, and typed message payloads validates correctly via zod
  4. Project builds and lints cleanly with a single `pnpm build` command
**Plans:** 2 plans

Plans:
- [x] 01-01-PLAN.md — Monorepo scaffolding: root configs, workspace setup, stub app packages
- [x] 01-02-PLAN.md — Shared protocol: Zod schemas, types, builders, constants, tests

### Phase 2: Local Proxy - PTY Transparency
**Goal**: Users can run `cc-anywhere` instead of `claude` with zero observable difference in terminal behavior
**Depends on**: Phase 1
**Requirements**: PROXY-01
**Success Criteria** (what must be TRUE):
  1. User runs `cc-anywhere` and sees identical terminal output to running `claude` directly (ANSI colors, cursor movement, interactive prompts all preserved)
  2. Terminal resize (SIGWINCH) propagates correctly -- resizing the window mid-session adjusts Claude Code's output layout
  3. Ctrl+C, Ctrl+D, and other signal keys behave identically to native Claude Code
  4. Exiting cc-anywhere cleanly terminates the underlying claude process with no orphans
**Plans:** 2 plans

Plans:
- [x] 02-01-PLAN.md — PTY core: node-pty install, PtyManager class, noop tap, unit tests
- [x] 02-02-PLAN.md — CLI entry point: index.ts wiring, bin registration, manual transparency verification

### Phase 3: Local Proxy - Service Architecture & Multi-Session
**Goal**: The proxy runs as a service+client architecture where a long-running service manages all sessions (PTY and JSON modes) and CLI clients connect via Unix domain socket IPC
**Depends on**: Phase 2
**Requirements**: PROXY-02, PROXY-03
**Success Criteria** (what must be TRUE):
  1. PTY sessions (terminal) and JSON sessions (stream-json) coexist in the same service without interfering with each other
  2. User can create multiple concurrent Claude Code sessions, each operating independently
  3. Each session reports its status (idle, working, waiting for approval, error) and can be individually terminated
  4. When a session is terminated or crashes, its claude child process is cleaned up within seconds (no orphaned processes)
  5. A periodic reaper detects and cleans up any orphaned claude processes that escaped normal cleanup
**Plans:** 3 plans

Plans:
- [x] 03-01-PLAN.md — Foundational utilities: LineBuffer, IPC protocol, PtyManager refactor for multi-session
- [x] 03-02-PLAN.md — Core business logic: SessionManager with persistence/reaper, JsonSession with stream-json parsing
- [x] 03-03-PLAN.md — System wiring: service entry point, client entry point, commander CLI routing

### Phase 4: Relay Server - Core Transport
**Goal**: Local proxy and remote clients can exchange messages through a public WebSocket relay with guaranteed ordering
**Depends on**: Phase 3
**Requirements**: RELAY-01, RELAY-03
**Success Criteria** (what must be TRUE):
  1. Local proxy connects to relay server via outbound WebSocket (no public IP or port forwarding needed on user's machine)
  2. Messages from proxy arrive at connected clients with correct ordering verified by sequence numbers
  3. A WebSocket test client can send a message through relay to proxy and receive Claude Code's response in real time
  4. Message loss is detected via sequence number gaps and reported (not silently dropped)
**Plans:** 3 plans

Plans:
- [x] 04-01-PLAN.md — Taro spike: validate Feishu mini program WebSocket connectivity with echo server
- [x] 04-02-PLAN.md — Relay server core: control schemas, registry, router, handlers, health checks
- [x] 04-03-PLAN.md — Proxy relay integration and Docker deployment infrastructure

### Phase 5: Relay Server - Resilience
**Goal**: The relay handles real-world network instability without losing messages or breaking sessions
**Depends on**: Phase 4
**Requirements**: RELAY-02, RELAY-04
**Success Criteria** (what must be TRUE):
  1. When proxy loses connection, it automatically reconnects with exponential backoff and resumes the session
  2. Messages sent during a disconnection are queued and delivered after reconnection (no silent message loss)
  3. When Feishu mini program goes to background and its WebSocket drops, the relay buffers messages and replays them on reconnection
  4. After reconnection, both proxy and client receive only the messages they missed (no duplicates, no gaps)
**Plans:** 3 plans

Plans:
- [x] 05-01-PLAN.md — Shared protocol extension and proxy-side auto-reconnect with message queuing
- [x] 05-02-PLAN.md — Relay per-session buffering with compression and proxy grace period lifecycle
- [x] 05-03-PLAN.md — Client reconnect protocol and seq gap detection/replay

### Phase 6: Feishu Mini Program - Core Interaction
**Goal**: Users can send messages to Claude Code and see streaming responses from their phone, manage sessions, approve tools, and browse history
**Depends on**: Phase 5
**Requirements**: FEISHU-01, FEISHU-03, FEISHU-04
**Success Criteria** (what must be TRUE):
  1. User types a message in the mini program and sees Claude Code's response streaming in real time (not waiting for complete response)
  2. User sees a list of active sessions and can create a new session, switch between sessions, or terminate a session
  3. User can scroll back through conversation history within a session, including messages exchanged before the current connection
  4. Mini program reconnects automatically when returning from background, and missed messages appear without user action
**Plans:** 13 plans
**UI hint**: yes

Plans:
- [x] 06-01-PLAN.md — Shared schema extensions: terminal_frame, pty_state, new relay control messages, SessionCreate cwd
- [x] 06-02-PLAN.md — Proxy terminal grid extraction and OSC semantic signal extractor
- [x] 06-03-PLAN.md — Proxy tool approval forwarding, session resume, env filtering, fork-session
- [x] 06-04-PLAN.md — Proxy command discovery, file watcher, directory listing
- [x] 06-05-PLAN.md — Relay routing updates and proxy terminal frame push, control message handlers
- [x] 06-06-PLAN.md — Mini program services: WebSocket, relay client, message parser, types, utilities
- [x] 06-07-PLAN.md — Mini program proxy select and session list pages with responsive layout
- [x] 06-08-PLAN.md — Mini program chat page: PTY terminal viewport, JSON chat bubbles, input bar, responsive layout
- [x] 06-09-PLAN.md — Mini program tool approval UI, tool call cards, back-to-bottom button
- [x] 06-10-PLAN.md — Mini program state stores, StatusLine, useScreenSize hook, app lifecycle, responsive CSS infrastructure
- [x] 06-11-PLAN.md — Mini program pickers (slash/file/directory), message quoting, settings menu, responsive adaptations
- [x] 06-12-PLAN.md — Gap closure: fix WebSocket duplicate connections, chat-store toolIndex matching, spike-picker compile error, message-parser type safety
- [x] 06-13-PLAN.md — Gap closure: wire chat page relay send/receive, session-list response handling, tool approval relay dispatch

### Phase 7: Tool Approval & Dual-Surface Sync
**Goal**: Users can approve or deny Claude Code tool calls from their phone, and terminal + mobile stay in sync during simultaneous use
**Depends on**: Phase 6
**Requirements**: FEISHU-02, PROXY-04
**Success Criteria** (what must be TRUE):
  1. When Claude Code requests tool execution, the mini program displays an approval dialog showing tool name and parameter preview
  2. User taps approve or deny, and Claude Code proceeds or aborts accordingly within seconds
  3. If user does not respond within the timeout period, the tool call is automatically denied (no indefinite hang)
  4. When user types in terminal while mini program is connected, both surfaces show consistent state and output
  5. When user sends input from mini program while terminal is open, the terminal reflects the interaction
**Plans**: TBD
**UI hint**: yes

Plans:
- [ ] 07-01: TBD
- [ ] 07-02: TBD

### Phase 8: Output Rendering
**Goal**: Claude Code output is rendered in mobile-friendly structured format instead of raw text
**Depends on**: Phase 6
**Requirements**: FEISHU-05, UX-01
**Success Criteria** (what must be TRUE):
  1. Markdown content renders with proper formatting (headers, lists, bold, italic, links)
  2. Code blocks display with syntax highlighting appropriate for the language
  3. Diff output shows additions and deletions with distinct colors
  4. Tool call results appear as collapsible cards showing tool name, parameters, and output
  5. Long output is scrollable and does not break the chat layout on small screens
**Plans**: TBD
**UI hint**: yes

Plans:
- [ ] 08-01: TBD
- [ ] 08-02: TBD

### Phase 9: Voice Input
**Goal**: Users can speak instead of type to send instructions to Claude Code
**Depends on**: Phase 6
**Requirements**: VOICE-01
**Success Criteria** (what must be TRUE):
  1. User holds a microphone button, speaks, and the transcribed text appears as a message to Claude Code
  2. User can review and edit the transcribed text before sending
  3. Voice input works for both Chinese and English speech
**Plans**: TBD
**UI hint**: yes

Plans:
- [ ] 09-01: TBD

### Phase 10: Notifications, Quick Actions & Session Polish
**Goal**: Mobile experience is polished with proactive notifications, reduced typing friction, and session organization
**Depends on**: Phase 7, Phase 8
**Requirements**: UX-02, UX-03, UX-04, UX-05
**Success Criteria** (what must be TRUE):
  1. User receives a Feishu notification when Claude Code finishes a task, encounters an error, or needs tool approval
  2. Quick action buttons for common commands (/compact, /status, etc.) are available and send the command with a single tap
  3. User can rename sessions and see status labels (idle, working, waiting for approval, error) at a glance in the session list
  4. Each session displays token usage, running time, and tool call count
**Plans**: TBD
**UI hint**: yes

Plans:
- [ ] 10-01: TBD
- [ ] 10-02: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Monorepo & Shared Protocol | 0/2 | Planning complete | - |
| 2. Local Proxy - PTY Transparency | 0/2 | Planning complete | - |
| 3. Local Proxy - Service Architecture & Multi-Session | 0/3 | Planning complete | - |
| 4. Relay Server - Core Transport | 0/3 | Planning complete | - |
| 5. Relay Server - Resilience | 0/3 | Planning complete | - |
| 6. Feishu Mini Program - Core Interaction | 11/13 | Gap closure | - |
| 7. Tool Approval & Dual-Surface Sync | 0/2 | Not started | - |
| 8. Output Rendering | 0/2 | Not started | - |
| 9. Voice Input | 0/1 | Not started | - |
| 10. Notifications, Quick Actions & Session Polish | 0/2 | Not started | - |
