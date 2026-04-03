# Feature Landscape

**Domain:** CLI remote control / mobile dev assistant (Claude Code + Feishu)
**Researched:** 2026-04-03

## Competitive Context

CC Anywhere enters a space with three categories of existing solutions:

1. **Official Claude Code Remote Control** (shipped 2026-02-25): Built-in feature in Claude Code v2.1.51+ that bridges local CLI sessions to the Claude mobile app/web via Anthropic's API. Requires Claude subscription, works only through Anthropic's own mobile app/web interface. Also has Channels (Telegram, Discord, iMessage) and Dispatch for mobile-initiated tasks.

2. **SessionCast**: Open-source terminal streaming tool (Java/Spring Boot + React/xterm.js) with sub-50ms WebSocket latency, bidirectional input, multi-session management, Google OAuth2 auth. Generic terminal streaming, not Claude Code-specific.

3. **Feishu-Claude Code bots** (feishu-claudecode, cc-connect, remote-claude-code): Python/Node bridges using Feishu bot API + WebSocket long connections. Invoke Claude Code via `--print --output-format stream-json` subprocess, update Feishu interactive cards in real-time. No terminal transparency -- they replace the terminal experience rather than augmenting it.

**CC Anywhere's differentiator**: Transparent proxy that preserves native terminal experience + Feishu mini program (richer UI than bot cards) + the local proxy doesn't interfere when user returns to desktop. Existing feishu bots sacrifice terminal transparency; official Remote Control requires Anthropic's app (no Feishu).

---

## Table Stakes

Features users expect. Missing any of these means the product fails at its core promise.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Transparent CLI proxy** | Core value prop: wrapping claude process without altering terminal behavior. User at desktop must see zero difference. | High | Must handle stdin/stdout/stderr passthrough, TTY signals, ANSI escape sequences, Claude Code's interactive prompts (tool approval, y/n), and process lifecycle. This is the hardest table-stakes feature. |
| **Real-time bidirectional messaging** | Users expect to send messages and see output in real-time, not poll. Official Remote Control and SessionCast both offer this. | Med | WebSocket from local proxy to relay server. Must handle streaming output (Claude Code outputs token-by-token). |
| **Multi-session management** | Developers commonly run multiple Claude Code instances on different projects. Official Remote Control supports 32 concurrent sessions. cc-connect supports multi-user isolated sessions. | Med | Session list, create/switch/terminate. Each session maps to one claude CLI process. |
| **Tool call approval from mobile** | Claude Code's permission system is critical for safety. Both official Remote Control and Channels support remote approval. claude-push exists specifically because this is a pain point. | Med | Must show what tool wants to do (tool name, description, input preview), provide approve/deny buttons. Latency matters: agent blocks while waiting. |
| **Session persistence / history** | When user opens the mini program, they need to see what Claude has been doing. Official Remote Control syncs conversation history. feishu-claudecode shows streaming updates. | Med | Store message history server-side or in relay. Allow reconnect without losing context. |
| **Connection resilience** | Network drops happen, especially on mobile. Official Remote Control auto-reconnects when machine comes back online. | Med | WebSocket reconnection with backoff, message queue for offline periods, session state recovery. |
| **Relay server (NAT traversal)** | Local machines are behind NAT. All competing solutions solve this: Anthropic routes through their API, feishu bots use WebSocket long connections, SessionCast uses relay. | Med | Local proxy initiates outbound WebSocket to public relay server. No inbound ports needed. |
| **Basic mobile UI for output viewing** | Must render Claude Code output readably on a phone screen. At minimum: text with basic formatting, code blocks distinguishable, scrollable. | Med | Feishu mini program UI. Don't need full terminal emulation (that's an anti-feature on mobile), but need readable rendering of structured output. |

---

## Differentiators

Features that set CC Anywhere apart from the competition. Not expected, but valued.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Feishu-native mini program UI** | Richer than bot cards (which existing feishu integrations use). Session list, conversation view, approval dialogs, settings -- all in a proper mini program rather than chat message cards. No other tool offers Feishu mini program for Claude Code. | High | Mini program development, Feishu review process, platform-specific APIs. Main differentiator vs existing feishu bots. |
| **Terminal transparency guarantee** | Unlike feishu-claudecode/cc-connect which use `--print --output-format stream-json` (non-interactive mode), CC Anywhere wraps the actual interactive CLI process. User at desktop gets the exact native experience. | High | This is technically the hardest differentiator. Must intercept I/O without breaking Claude Code's TUI (ink-based React terminal UI), interactive prompts, permission dialogs, etc. |
| **Dual-surface operation** | Like official Remote Control: use from terminal AND mobile simultaneously, conversation stays in sync. Existing feishu bots are mobile-only -- you lose the terminal. | High | State synchronization between local terminal and remote mini program. Both surfaces must reflect current state. |
| **Smart output rendering for mobile** | Parse Claude Code's structured output (markdown, code blocks, diffs, tool call results) and render appropriately for mobile instead of raw terminal dump. | Med | Claude Code outputs structured JSON in stream mode. Parse and render: markdown as rich text, code with syntax highlighting, diffs with color coding, tool calls as collapsible cards. |
| **Session naming and organization** | Name sessions by project, see at-a-glance status (idle, working, waiting for approval, errored). | Low | UX improvement over plain session list. Low effort, high perceived quality. |
| **Quick actions / preset commands** | Common commands accessible with one tap: "/compact", "/status", approve-all for trusted operations, send a quick follow-up instruction. | Low | Reduces mobile typing friction. Big UX win on phone. |
| **Notification system** | Push notifications when: Claude finishes a task, Claude needs approval, Claude encounters an error, session disconnects. Users shouldn't have to keep checking. | Med | Feishu mini program supports subscribe messages. Also consider Feishu bot notifications as fallback channel. |
| **Session cost/usage tracking** | Show token usage, time elapsed, number of tool calls per session. feishu-claudecode already has basic cost/time stats in status cards. | Low | Parse from Claude Code output or track at proxy level. Developers care about costs. |

---

## Anti-Features

Features to explicitly NOT build. These are traps that look appealing but would hurt the product.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Full terminal emulator in mini program** | xterm.js on mobile is a terrible UX. Small screen + ANSI escape sequences + scrolling = unusable. SessionCast does this and it's their weakness. Claude Code's ink-based TUI with spinners, progress bars, and interactive elements cannot be meaningfully replicated in a mini program. | Render structured output as native mobile UI components: message bubbles, code blocks, collapsible tool call cards, approval buttons. Parse the semantic content, don't render raw terminal. |
| **OAuth / multi-user auth system** | v1 targets personal/trust environments per PROJECT.md. Adding auth complexity delays launch and isn't needed for the single-user scenario. | Simple token/secret-based pairing between local proxy and relay server. One user, multiple sessions. |
| **Web UI** | Scope creep. Feishu mini program is the mobile surface. Official Remote Control already has claude.ai/code for web. | Focus exclusively on Feishu mini program for v1. |
| **Cloud-hosted Claude Code instances** | Out of scope per PROJECT.md. Claude Code runs locally. The entire architecture assumes local execution. | Local proxy wrapping local claude CLI process. All computation stays on user's machine. |
| **File editing / code review in mini program** | Mobile screen is wrong for reading/editing code. Diff views on a phone are painful. | Show summary of what changed (file names, line counts), link back to desktop for details. Allow text instructions like "revert that last change" instead of manual editing. |
| **Feishu group chat / multi-user collaboration** | v1 is single-user per PROJECT.md. Group dynamics add complexity: who can approve? whose session? conflict resolution. | Single user controlling their own sessions. Multi-user is a v2 consideration. |
| **Custom model routing / API proxying** | Other tools (CLIProxyAPI, liteLLM proxies) handle model switching. CC Anywhere's value is remote access, not model flexibility. | Pass through whatever Claude Code instance the user has configured locally. |
| **Automated task scheduling** | Official Claude Code already has scheduled tasks. Duplicating this in Feishu adds no value. | Focus on real-time interactive control, not automation. |

---

## Feature Dependencies

```
Transparent CLI proxy
  -> Real-time bidirectional messaging (proxy captures output to forward)
    -> Relay server (messaging needs a public bridge)
      -> Feishu mini program (needs relay to receive messages)
        -> Tool call approval (needs message channel + UI)
        -> Session persistence (needs message storage)
        -> Notification system (needs relay to push events)

Multi-session management
  -> Session list UI in mini program
  -> Session naming and organization

Smart output rendering
  -> Requires output parsing layer in proxy (convert raw terminal to structured data)

Dual-surface operation
  -> Requires transparent proxy (terminal still works)
  -> Requires state sync protocol (both surfaces reflect same state)

Quick actions
  -> Requires bidirectional messaging (send commands from mobile)

Connection resilience
  -> Requires message queuing in relay
  -> Requires session state persistence
```

**Critical path**: Transparent CLI proxy -> Relay server -> Feishu mini program -> Bidirectional messaging -> Tool call approval. Everything else builds on this chain.

---

## MVP Recommendation

### Phase 1: Core Pipeline (must work end-to-end)

Prioritize in this order:

1. **Transparent CLI proxy** -- Without this, there's no product. Hardest piece, do it first.
2. **Relay server** -- WebSocket bridge, minimal. Just forwards messages between proxy and mini program.
3. **Feishu mini program skeleton** -- Basic UI: session list, conversation view, text input.
4. **Real-time bidirectional messaging** -- Send message from Feishu, see Claude output stream back.
5. **Tool call approval** -- Approve/deny from mobile. This unlocks "walk away from desk" use case.

### Phase 2: Usability

6. **Multi-session management** -- Create, list, switch, terminate sessions from mobile.
7. **Session persistence** -- Reconnect and see history.
8. **Connection resilience** -- Auto-reconnect, handle flaky mobile networks.
9. **Smart output rendering** -- Parse Claude output into readable mobile UI.

### Phase 3: Polish

10. **Notification system** -- Push when Claude needs attention.
11. **Quick actions** -- One-tap common commands.
12. **Session naming / organization** -- UX polish.
13. **Cost/usage tracking** -- Token counts, time stats.

### Defer indefinitely:
- Full terminal emulation in mini program
- Multi-user / group collaboration
- Web UI
- Custom model routing

---

## Feishu Mini Program Platform Constraints

Based on research (MEDIUM confidence -- official docs are sparse, extrapolating from ByteDance/WeChat mini program platform norms):

| Constraint | Detail | Impact on CC Anywhere |
|------------|--------|----------------------|
| **Package size** | Main package likely 2MB limit, total ~16MB with sub-packages (ByteDance platform norm) | Keep mini program lightweight. Heavy assets (fonts, icons) should be loaded remotely. |
| **WebSocket connections** | Maximum 5 simultaneous connections per mini program | One connection to relay server is sufficient. Don't open per-session connections. |
| **WebSocket message processing** | Must process within 3 seconds (Feishu long-connection mode) | Not directly applicable to mini program WebSocket, but relay server design should account for processing timeouts. |
| **Background execution** | Mini programs get destroyed after ~5 minutes in background on mobile | Cannot rely on mini program staying alive. Relay server must buffer messages. Push notifications for important events. |
| **Rich text rendering** | No native xterm.js support. Must use mini program components (text, rich-text, web-view). | Build custom rendering components for code blocks, markdown, diffs. |
| **Storage** | Local storage limited (typically 10MB) | Store session history on relay server, not locally. |
| **Review process** | Feishu mini program requires platform review for publication | Factor review time into release schedule. Ensure compliance with Feishu policies. |

---

## Sources

### Official Documentation (HIGH confidence)
- [Claude Code Remote Control docs](https://code.claude.com/docs/en/remote-control) -- Complete feature spec for official Remote Control
- [Claude Code Channels Reference](https://code.claude.com/docs/en/channels-reference) -- Channel plugin architecture, permission relay protocol
- [Feishu connectSocket API](https://open.feishu.cn/document/uYjL24iN/ugDMx4COwEjL4ATM) -- Max 5 WebSocket connections

### Competing Products (MEDIUM confidence)
- [SessionCast](https://sessioncast.io/) -- Terminal streaming tool, sub-50ms WebSocket, 3-tier architecture
- [feishu-claude-code](https://github.com/joewongjc/feishu-claude-code) -- Python WebSocket bridge, Feishu bot integration
- [cc-connect](https://github.com/chenhg5/cc-connect) -- Multi-platform bridge for AI coding agents
- [claude-push](https://dev.to/coa00/how-i-built-a-mobile-approval-system-for-claude-code-so-i-can-finally-leave-my-desk-1ida) -- Mobile approval system using hooks + ntfy.sh

### Analysis Articles (LOW-MEDIUM confidence)
- [Harper Reed's blog on Claude Code mobile](https://harper.blog/2026/01/05/claude-code-is-better-on-your-phone/) -- DIY SSH/tmux/Tailscale approach
- [NxCode Remote Control Guide](https://www.nxcode.io/resources/news/claude-code-remote-control-mobile-terminal-handoff-guide-2026) -- Feature analysis
- [Remote Control permission mode gap](https://github.com/anthropics/claude-code/issues/29319) -- Mobile permission cycling not supported
