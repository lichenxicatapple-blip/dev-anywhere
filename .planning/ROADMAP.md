# Roadmap: CC Anywhere

## Milestones

- [x] **v1.0 MVP** - Phases 1-6 (shipped 2026-04-14)
- [ ] **v2.0 React SPA + xterm.js Migration** - Phases 7-14 (in progress)

## Phases

<details>
<summary>v1.0 MVP (Phases 1-6) - SHIPPED 2026-04-14</summary>

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
- [x] 01-01-PLAN.md
- [x] 01-02-PLAN.md

### Phase 2: Local Proxy - PTY Transparency
**Goal**: Users can run `cc-anywhere` instead of `claude` with zero observable difference in terminal behavior
**Depends on**: Phase 1
**Requirements**: PROXY-01
**Plans:** 2 plans

Plans:
- [x] 02-01-PLAN.md
- [x] 02-02-PLAN.md

### Phase 3: Local Proxy - Service Architecture & Multi-Session
**Goal**: The proxy runs as a service+client architecture where a long-running service manages all sessions
**Depends on**: Phase 2
**Requirements**: PROXY-02, PROXY-03
**Plans:** 3 plans

Plans:
- [x] 03-01-PLAN.md
- [x] 03-02-PLAN.md
- [x] 03-03-PLAN.md

### Phase 4: Relay Server - Core Transport
**Goal**: Local proxy and remote clients can exchange messages through a public WebSocket relay
**Depends on**: Phase 3
**Requirements**: RELAY-01, RELAY-03
**Plans:** 3 plans

Plans:
- [x] 04-01-PLAN.md
- [x] 04-02-PLAN.md
- [x] 04-03-PLAN.md

### Phase 5: Relay Server - Resilience
**Goal**: The relay handles real-world network instability without losing messages or breaking sessions
**Depends on**: Phase 4
**Requirements**: RELAY-02, RELAY-04
**Plans:** 3 plans

Plans:
- [x] 05-01-PLAN.md
- [x] 05-02-PLAN.md
- [x] 05-03-PLAN.md

### Phase 6: Feishu Mini Program - Core Interaction
**Goal**: Users can send messages to Claude Code and see streaming responses from their phone
**Depends on**: Phase 5
**Requirements**: FEISHU-01, FEISHU-03, FEISHU-04
**Plans:** 13 plans

Plans:
- [x] 06-01-PLAN.md through 06-13-PLAN.md

</details>

## v2.0 React SPA + xterm.js Migration

**Milestone Goal:** Replace Taro mini program with React SPA + PWA. Replace custom terminal renderer with xterm.js. Simplify full-chain PTY pipeline to binary passthrough. Make the app deployable and installable on any device.

**Phase Numbering:**
- Integer phases (7, 8, 9, ...): Planned milestone work
- Decimal phases (8.1, 8.2): Urgent insertions (marked with INSERTED)

- [x] **Phase 7: Project Scaffold + Design Tokens** - Vite + React + Tailwind + shadcn/ui project with design tokens and dev tooling
- [ ] **Phase 8: Business Logic Adaptation** - Migrate state machine, stores, and WebSocket layer to browser-native APIs
- [ ] **Phase 9: PTY Pipeline Full Chain** - EventStore persistence, binary WebSocket frames, relay passthrough, xterm.js rendering
- [x] **Phase 10: Pages + Components Migration** - All three pages and 17 custom components migrated to HTML + Tailwind + shadcn/ui (completed 2026-04-18)
- [ ] **Phase 11: PTY Resilience** - Client reconnection with snapshot replay, multi-client broadcast, session history playback
- [ ] **Phase 12: Deployment + PWA Basics** - Relay serves static files, PWA manifest, app icons, offline shell
- [ ] **Phase 13: PWA Advanced Features** - Screen Wake Lock, voice input, voice readback
- [ ] **Phase 14: Notifications + Quick Actions** - Browser Push API notifications, quick action panel

## Phase Details

### Phase 7: Project Scaffold + Design Tokens
**Goal**: A working Vite + React + Tailwind + shadcn/ui project that builds, with design tokens defined and dev server proxying WebSocket to relay
**Depends on**: Phase 6 (v1.0 foundation)
**Requirements**: FRONT-01, FRONT-02, DEPLOY-02
**Success Criteria** (what must be TRUE):
  1. `pnpm --filter web dev` starts Vite dev server and renders a page with correct dark theme colors (#1E1E1E surface, #D4D4D4 text)
  2. `pnpm --filter web build` produces a dist/ folder with all assets
  3. shadcn/ui Button component renders with the project's accent color (#00D4AA) and design tokens (spacing, radius, font) are applied
  4. Vite dev server proxies WebSocket connections to a local relay, so the web app can connect to the relay during development
**Plans:** 2 plans
**UI hint**: yes

Plans:
- [x] 07-01-PLAN.md — Scaffold apps/web with Vite + React 19 + Tailwind v4 + shadcn/ui, define design tokens, configure dev proxy
- [x] 07-02-PLAN.md — Create Token Showcase page to visually validate all design tokens and get human approval

### Phase 8: Business Logic Adaptation
**Goal**: All non-UI business logic (state machine, stores, services, WebSocket layer) works with browser-native APIs instead of Taro
**Depends on**: Phase 7
**Requirements**: FRONT-09, FRONT-10
**Success Criteria** (what must be TRUE):
  1. phase-machine navigates between routes using react-router (hash mode), with localStorage replacing Taro storage
  2. relay-store establishes WebSocket connection using native browser WebSocket (no Taro codepath), including binary frame reception
  3. All migrated stores and services pass type checking (`pnpm --filter web typecheck`)
**Plans:** 3 plans

Plans:
- [x] 08-01-PLAN.md — Zustand stores (app/session/chat/command/file/toast), hash router config, toast component
- [x] 08-02-PLAN.md — WebSocket manager (text+binary+backoff), relay-client, ensure-binding, phase-machine
- [x] 08-03-PLAN.md — App.tsx wiring, useRelaySetup hook, pty-test unified WebSocket, end-to-end verification

### Phase 9: PTY Pipeline Full Chain
**Goal**: Raw PTY bytes flow from proxy through relay to browser xterm.js, with all data persisted to disk for recovery
**Depends on**: Phase 7
**Requirements**: PTY-01, PTY-02, PTY-03, PTY-04, FRONT-07
**Success Criteria** (what must be TRUE):
  1. Proxy persists all PTY output to disk via EventStore (CCAE binary format, immediate writeSync, truncation rotation)
  2. Proxy generates periodic xterm snapshots via @xterm/headless + serialize addon (every 100 events, snapshot embeds cols/rows)
  3. Live PTY output appears in browser xterm.js terminal with correct ANSI colors, cursor positioning, and CJK character rendering
  4. Binary WebSocket frames flow through relay without parsing or modification (relay distinguishes binary=PTY vs text=JSON at protocol level)
  5. EventStore infrastructure supports disk recovery (findLatestSnapshot reverse scan, snapshot-based replay module ready for Phase 11 client reconnection)
**Plans:** 4 plans
**UI hint**: yes

Plans:
- [x] 09-01-PLAN.md — EventStore CCAE binary persistence + headless xterm snapshots + delete old pipeline
- [x] 09-02-PLAN.md — Proxy-side IPC mixed protocol + RelayConnection binary forwarding
- [x] 09-03-PLAN.md — Relay binary passthrough + delete buffer code + clean shared types
- [x] 09-04-PLAN.md — Browser /pty-test page with xterm.js + visual verification

### Phase 10: Pages + Components Migration
**Goal**: All three pages (proxy-select, session-list, chat) and all custom components render with HTML + Tailwind + shadcn/ui, full app navigation works end-to-end
**Depends on**: Phase 8, Phase 9
**Requirements**: FRONT-03, FRONT-04, FRONT-05, FRONT-06, FRONT-08
**Success Criteria** (what must be TRUE):
  1. User opens the app and sees proxy selection page, can select a proxy and navigate to session list
  2. User sees active sessions, can create a new session, switch between sessions, or terminate a session
  3. Chat page renders JSON mode (chat bubbles, Markdown, tool approval cards) and PTY mode (xterm.js terminal) correctly
  4. All shared UI components (InputBar, Toast, Modal, StatusLine, BackToBottom, etc.) work with shadcn/ui replacements
  5. App shell provides safe area handling, navigation header, and responsive layout across mobile/tablet/desktop breakpoints
**Plans:** 8/8 plans complete
**UI hint**: yes

Plans:
- [x] 10-01a-PLAN.md — shadcn atom set install + Phase 10 theme override (amber primary, 0.375rem radius, Button font-weight 400) + Playwright e2e scaffolding
- [x] 10-01b-PLAN.md — AppShell + Sidebar + EmptyState + CommandPalette (Cmd+K) + Sonner migration + nested router with AppShell as parent
- [x] 10-02-PLAN.md — ProxySwitcher dual-layout (page | dropdown) + ProxyStatusDot + rewritten proxy-select page + sidebar dropdown slot
- [x] 10-03-PLAN.md — SessionList dual-layout + SessionRow + CreateSessionDialog + master-detail instant switch
- [x] 10-04a-PLAN.md — Chat JSON core rendering (virtualized messages + Markdown + ToolApprovalCard + BackToBottom + StatusLine + chat-dispatcher wiring)
- [x] 10-04b-PLAN.md — Chat JSON input half + ChatHeader + SemanticActionPanel (JSON+PTY routes) + shared FilePathPicker (refactors CreateSessionDialog CWD field)
- [x] 10-05-PLAN.md — Chat PTY primitives (createXterm factory + ChatPtyView self-contained + remote_input_raw envelope + ansi-keys 5 constants + proxy serve.ts branch)
- [x] 10-06-PLAN.md — chat-store per-session rewrite (retires CustomEvent bridge; SplitPane dual-chat 已按 D-52 降级至 backlog)

### Phase 11: PTY Resilience
**Goal**: PTY sessions survive disconnections, support multiple viewers, and can be replayed from history
**Depends on**: Phase 9
**Requirements**: PTY-05, PTY-06, PTY-07
**Success Criteria** (what must be TRUE):
  1. When client disconnects and reconnects, xterm.js shows the full terminal state (proxy sends latest snapshot + events since snapshot, client loads via serialize addon)
  2. Multiple browser tabs or devices viewing the same session each receive the live PTY byte stream independently
  3. User can replay a completed session's terminal history (EventStore events fed to xterm.js at real-time or accelerated speed)
  4. No duplicate data appears after reconnection (sequence-based deduplication between proxy and client)
**Plans**: TBD

Plans:
- [ ] 11-01: TBD
- [ ] 11-02: TBD

### Phase 12: Deployment + PWA Basics
**Goal**: The app is deployable as a single Docker container (relay + static files) and installable as a PWA on mobile devices
**Depends on**: Phase 10
**Requirements**: DEPLOY-01, PWA-01, PWA-02
**Success Criteria** (what must be TRUE):
  1. Relay process serves the built web SPA via express.static, accessible at the relay's URL without a separate web server
  2. Browser shows "Install" prompt (or Add to Home Screen) with correct app name, icons (192x192, 512x512), and theme color
  3. Installed PWA opens in standalone mode (no browser chrome) with the dark theme background
  4. Offline shell loads when network is unavailable (cached static assets via Service Worker)
**Plans**: TBD
**UI hint**: yes

Plans:
- [ ] 12-01: TBD
- [ ] 12-02: TBD

### Phase 13: PWA Advanced Features
**Goal**: The PWA leverages browser-native APIs that were impossible in the mini program: screen wake lock and voice interaction
**Depends on**: Phase 12
**Requirements**: PWA-03, PWA-04, PWA-05
**Success Criteria** (what must be TRUE):
  1. Screen stays awake while a session is active (Wake Lock acquired on session open, released on close or background)
  2. User holds a microphone button, speaks, and transcribed text appears in the input bar ready to send
  3. User can tap a button to have Claude Code's latest response read aloud via speech synthesis
  4. Voice features work for both Chinese and English
**Plans**: TBD
**UI hint**: yes

Plans:
- [ ] 13-01: TBD
- [ ] 13-02: TBD

### Phase 14: Notifications + Quick Actions
**Goal**: Users receive push notifications for important events and can trigger common commands with one tap
**Depends on**: Phase 12
**Requirements**: NOTIF-01, NOTIF-02
**Success Criteria** (what must be TRUE):
  1. Browser push notification fires when a task completes, tool approval is needed, or an error occurs (even when page is closed)
  2. Push notification click opens the relevant session in the PWA
  3. Quick action panel provides one-tap access to common commands (configurable)
  4. Quick action panel supports session switching shortcut
**Plans**: TBD

Plans:
- [ ] 14-01: TBD
- [ ] 14-02: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 7 -> 8 -> 9 -> 10 -> 11 -> 12 -> 13 -> 14

Note: Phases 8 and 9 can run in parallel after Phase 7. Phase 10 requires both 8 and 9.

```
Phase 7 --+-- Phase 8 ----------+
          |                     |
          +-- Phase 9 -- Phase 11
                                |
                  Phase 10 -----+-- Phase 12 --+-- Phase 13
                                               +-- Phase 14
```

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Monorepo & Shared Protocol | v1.0 | 2/2 | Complete | 2026-04-11 |
| 2. Local Proxy - PTY Transparency | v1.0 | 2/2 | Complete | 2026-04-11 |
| 3. Local Proxy - Service Architecture | v1.0 | 3/3 | Complete | 2026-04-11 |
| 4. Relay Server - Core Transport | v1.0 | 3/3 | Complete | 2026-04-12 |
| 5. Relay Server - Resilience | v1.0 | 3/3 | Complete | 2026-04-12 |
| 6. Feishu Mini Program - Core Interaction | v1.0 | 13/13 | Complete | 2026-04-14 |
| 7. Project Scaffold + Design Tokens | v2.0 | 2/2 | Complete | 2026-04-15 |
| 8. Business Logic Adaptation | v2.0 | 0/3 | Planned | - |
| 9. PTY Pipeline Full Chain | v2.0 | 4/4 | Complete | 2026-04-16 |
| 10. Pages + Components Migration | v2.0 | 8/8 | Complete   | 2026-04-18 |
| 11. PTY Resilience | v2.0 | 0/2 | Not started | - |
| 12. Deployment + PWA Basics | v2.0 | 0/2 | Not started | - |
| 13. PWA Advanced Features | v2.0 | 0/2 | Not started | - |
| 14. Notifications + Quick Actions | v2.0 | 0/2 | Not started | - |
