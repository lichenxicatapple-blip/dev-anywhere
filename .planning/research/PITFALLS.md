# Pitfalls Research

> **[SUPERSEDED]** 本文档中关于 Agent SDK (`@anthropic-ai/claude-agent-sdk`) 的推荐已过时。Phase 3 决定采用 `claude --stream-json` CLI 方案替代 Agent SDK，参见 `.planning/phases/03-local-proxy-service-multi-session/03-CONTEXT.md` D-05/D-06。

**Domain:** CLI transparent proxy + WebSocket relay + Feishu mini program (CC Anywhere)
**Researched:** 2026-04-03
**Confidence:** HIGH (PTY/WebSocket), MEDIUM (Feishu mini program specifics)

## Critical Pitfalls

### Pitfall 1: Claude Code TUI Full-Screen Redraw Floods PTY Proxy

**What goes wrong:**
Claude Code uses Ink (React-based terminal renderer) that performs full-screen redraws at 4,000-6,700 scroll events per second during streaming output. Each redraw emits ~4,095-byte chunks with heavy ANSI formatting (~189 KB/sec of escape codes alone). A naive PTY proxy that forwards all this raw output through WebSocket to a mobile client will:
1. Saturate the WebSocket connection with useless intermediate render frames
2. Cause the Feishu mini program to freeze parsing thousands of ANSI escape sequences per second
3. Generate massive bandwidth costs on mobile networks

**Why it happens:**
Developers assume terminal output is "just text" and forward it byte-for-byte. Claude Code's Ink renderer erases and redraws entire regions on every token, producing output volumes 40-600x higher than normal terminal programs. This is invisible when running locally (the terminal handles it natively) but catastrophic when relaying over a network.

**How to avoid:**
Do NOT relay raw PTY output to the mobile client. Instead:
1. Use the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) for the remote control channel. The SDK provides structured streaming events (text deltas, tool calls, status changes) that are machine-parseable and bandwidth-efficient.
2. Keep the PTY layer only for local terminal pass-through (user's native experience).
3. If using CLI mode: use `claude -p --output-format stream-json` which emits structured JSON events instead of terminal escape sequences.
4. If PTY raw output must be relayed (e.g., for a web terminal view), throttle to max 60 frames/sec by batching writes on 16ms intervals.

**Warning signs:**
- Mobile client becomes unresponsive during Claude Code streaming
- WebSocket message queue grows unboundedly during output
- Bandwidth usage spikes to megabytes per minute of conversation
- Mini program memory increases steadily during long sessions

**Phase to address:**
Phase 1 (local proxy architecture). This is a fundamental design decision -- getting it wrong means rewriting the entire message pipeline later. The dual-mode architecture (PTY for local terminal, Agent SDK for relay) must be established from day one.

---

### Pitfall 2: PTY Output Splits Multi-byte UTF-8 Characters

**What goes wrong:**
node-pty delivers output in arbitrary-sized chunks (commonly 4,095 bytes on macOS due to kernel pipe buffer size). These chunk boundaries can split multi-byte UTF-8 characters (CJK characters are 3 bytes, emoji are 4 bytes). If the proxy decodes each chunk independently as UTF-8, the split character becomes a U+FFFD replacement character, causing silent data corruption. This is especially damaging for a project with Chinese-speaking users where CJK characters are common.

**Why it happens:**
Node.js `Buffer.toString('utf8')` replaces incomplete trailing bytes with the replacement character. Developers test with ASCII-only output and never encounter the issue. A documented Node.js bug (nodejs/node#61744) shows this can cause silent data loss even in Node's own internal streams.

**How to avoid:**
1. Use `StringDecoder` from Node's `string_decoder` module, which buffers incomplete multi-byte sequences across chunks.
2. If using the Agent SDK's structured streaming, this is handled by the SDK (each event is a complete JSON object). But for PTY local pass-through, always pipe through StringDecoder before any string processing.
3. Test explicitly with CJK text and emoji in Claude Code output.

**Warning signs:**
- Garbled characters appearing intermittently in output, especially during fast streaming
- Characters only corrupt when output rate is high (more chunk boundaries = more split opportunities)
- U+FFFD replacement characters in logs

**Phase to address:**
Phase 1 (local proxy). Must be correct from the start since it corrupts user-visible data silently.

---

### Pitfall 3: Orphaned Claude Code Processes and Memory Leaks

**What goes wrong:**
When a WebSocket connection drops or the user closes the Feishu mini program, the Claude Code child process continues running. Over time, dozens of orphaned processes accumulate. Documented cases show 48 orphaned Claude subprocesses consuming 2.3 GB of memory after 17 hours. Each Claude Code process also maintains its own context window in memory, so resource consumption scales linearly with orphan count.

**Why it happens:**
1. WebSocket disconnections are silent -- no error event, just absence of pings
2. node-pty does not automatically kill child processes when the parent's reference is garbage collected
3. SIGTERM sent to the proxy process does not automatically propagate to PTY children
4. The Agent SDK's `query()` returns a `Query` object with `close()` method that must be called explicitly
5. Developers implement "create session" but defer "cleanup session" to later phases

**How to avoid:**
1. Implement process lifecycle management from day one:
   - Track all spawned processes in a registry with creation timestamps
   - For PTY sessions: send SIGTERM, follow with SIGKILL after 5-second grace period
   - For Agent SDK sessions: call `query.close()` which terminates the underlying process
   - Run a periodic reaper (every 60s) that kills processes whose sessions are dead
2. Handle all termination signals (SIGINT, SIGTERM, SIGHUP) in the proxy process to clean up children
3. Use process groups (`detached: false` in spawn options) so the OS can clean up on proxy crash
4. Implement heartbeat between proxy and relay server; missed heartbeats trigger cleanup

**Warning signs:**
- `ps aux | grep claude` shows processes you didn't expect
- System memory usage grows steadily over hours
- New sessions become sluggish (resource contention)
- Claude API rate limits hit unexpectedly (orphans may still be making API calls)

**Phase to address:**
Phase 1 (local proxy). Session lifecycle is core infrastructure. Build the cleanup path alongside the creation path.

---

### Pitfall 4: WebSocket Reconnection Without State Recovery Causes Message Loss

**What goes wrong:**
Mobile networks are inherently unstable -- WiFi-to-cellular handoffs, elevator dead zones, app backgrounding on iOS/Android. When the WebSocket between Feishu mini program and relay server drops, messages sent during the disconnection window are permanently lost. The user sees Claude Code's output jump from one point to another with a gap. Worse: if the user sent an approval for a tool call during disconnection, Claude Code never receives it and hangs indefinitely.

**Why it happens:**
WebSocket is a transport protocol with no built-in delivery guarantees. Developers implement reconnection (the easy part) but skip state recovery (the hard part).

**How to avoid:**
1. Assign monotonically increasing sequence numbers to all messages
2. Client tracks last received sequence number; sends it on reconnect
3. Relay server maintains a per-session message buffer (last N messages or last T seconds, with configurable TTL)
4. On reconnect, replay all messages after the client's last-seen sequence
5. Client-side: queue outbound messages until server acknowledges receipt
6. Implement exponential backoff with jitter (1s, 2s, 4s... cap at 30s, add random 0-50% jitter) to prevent thundering herd on server recovery

**Warning signs:**
- Users report "missing output" or "jumped ahead" after network interruption
- Tool approval requests never reach the user (Claude Code hangs)
- Multiple clients reconnecting simultaneously crash the relay server

**Phase to address:**
Phase 2 (relay server). The message protocol with sequence numbers must be designed into the relay from the beginning, not bolted on later. But implementation of the buffer and replay can be iterative.

---

### Pitfall 5: Tool Call Approval Deadlock

**What goes wrong:**
Claude Code pauses execution and waits for user confirmation when it wants to run a tool (file edit, bash command, etc.). If the mobile user is disconnected, the approval prompt is lost, and Claude Code hangs indefinitely. If the approval response arrives out of order (approval for tool call #2 arrives before #1), Claude Code enters an undefined state.

**Why it happens:**
Tool call approval is the hardest interaction pattern to proxy correctly because:
1. It requires bidirectional synchronous communication through an asynchronous relay
2. In PTY mode, Claude Code's approval prompts must be reliably detected and parsed from terminal output
3. In Agent SDK mode, the `canUseTool` callback is invoked synchronously -- the SDK waits for the Promise to resolve

**How to avoid:**
1. Use the Agent SDK's `canUseTool` callback for structured tool approval. This callback receives the tool name, input, and a unique `toolUseID`, eliminating parsing ambiguity.
2. Pre-approve safe tools via `allowedTools` to reduce approval frequency (e.g., `["Read", "Grep", "Glob"]`)
3. Implement approval timeouts: if no response within configurable duration (e.g., 5 minutes), deny the tool call and notify the user
4. Maintain a pending-approval queue with unique IDs to prevent out-of-order responses
5. On reconnection, replay any pending approval requests to the mobile client
6. Allow both local terminal and remote Feishu to approve (first response wins)

**Warning signs:**
- Claude Code sessions appear "stuck" with no output
- User sees tool approval request but response has no effect
- Approval responses applied to wrong tool calls

**Phase to address:**
Phase 2 (relay protocol) and Phase 3 (Feishu mini program UI). The protocol must support approval-specific message types early. The UI must make pending approvals prominent and persistent.

---

### Pitfall 6: Agent SDK Version Instability

**What goes wrong:**
The Claude Agent SDK is at v0.2.x. Anthropic recently renamed the package from `@anthropic-ai/claude-code` to `@anthropic-ai/claude-agent-sdk`. A V2 interface preview is available, signaling more API changes. Building directly against the SDK without an abstraction layer means every upgrade propagates changes throughout the codebase.

**Why it happens:**
The SDK is actively evolving. It was originally designed for headless CI/CD usage and is being expanded for broader programmatic control. The API surface is large (26 message types, multiple configuration options) and still settling.

**How to avoid:**
1. Pin exact SDK version in package.json (not `^`, use exact)
2. Wrap SDK calls behind a thin adapter interface in the shared package. The adapter exposes only the operations CC Anywhere needs: start session, send message, receive events, approve tool, close session.
3. When upgrading, only the adapter implementation changes
4. Run integration tests against the SDK on every version bump
5. Monitor the [migration guide](https://platform.claude.com/docs/en/agent-sdk/migration-guide) for breaking changes

**Warning signs:**
- Import paths change between versions
- New required parameters appear on existing functions
- Message type unions gain new members that break exhaustive switches

**Phase to address:**
Phase 1 (architecture). The adapter interface must be designed from the start.

---

### Pitfall 7: Feishu Mini Program WebSocket and Platform Constraints

**What goes wrong:**
Feishu mini programs run in a constrained sandbox environment that differs significantly from a browser. Developers build and test in the simulator, then discover on real devices that:
1. Max 5 concurrent WebSocket connections per mini program
2. The mini program is suspended when backgrounded on mobile (WebSocket disconnects silently)
3. The simulator does not support most native APIs -- WebSocket falls under "network APIs" that require real device testing
4. Feishu's China version (feishu.cn) and international version (lark) may have different API availability
5. Mini program package size limits may force code splitting

**Why it happens:**
The Feishu mini program platform has limited public documentation compared to WeChat mini programs. Many constraints are discovered only during real device testing or app review. The simulator's inability to run network APIs means critical bugs surface late in development.

**How to avoid:**
1. Set up real device debugging from day one -- never rely solely on the simulator for WebSocket features
2. Multiplex all sessions over a single WebSocket connection (avoid the 5-connection limit)
3. Implement robust connection lifecycle management that handles app backgrounding/foregrounding
4. Use heartbeat pings to detect silent WebSocket disconnection (the platform may not fire close events)
5. Decide early: target Feishu (China) or Lark (international), not both simultaneously for v1
6. Budget for the Feishu app review process

**Warning signs:**
- Features work in simulator but fail on real device
- WebSocket connects in development but fails in production (domain whitelist not configured)
- App review rejection due to undeclared permissions or missing privacy policy

**Phase to address:**
Phase 3 (Feishu mini program). But platform choice (Feishu vs Lark) and domain configuration must be decided in Phase 1 planning.

---

### Pitfall 8: Transparent Proxy Breaks Local Terminal Experience

**What goes wrong:**
The project requirement states "local proxy must not interfere with native Claude Code terminal experience." But inserting a PTY proxy layer between the user's terminal and Claude Code can break:
1. Terminal window resize propagation (SIGWINCH) -- the proxy must relay resize events via `pty.resize()`, and race conditions during resize cause garbled output
2. Signal handling -- Ctrl+C (SIGINT) must reach Claude Code, not be caught by the proxy
3. Raw mode input -- special key sequences (arrow keys, Ctrl+key combos, escape sequences) must pass through unmodified
4. Alternate screen buffer -- Claude Code may switch between main and alternate buffers; the proxy must not interfere
5. Clipboard integration, bracketed paste mode, mouse events -- all terminal features must be transparent

**Why it happens:**
node-pty creates a new PTY pair, which means the proxy's terminal and Claude Code's PTY are separate. Terminal state (size, mode, encoding) must be manually synchronized. Any mismatch causes visual corruption or broken interaction.

**How to avoid:**
1. On proxy startup, read the parent terminal's size and pass it to `pty.spawn()` as `cols` and `rows`
2. Listen for SIGWINCH on the parent process and call `pty.resize()` immediately
3. Set the parent terminal to raw mode (`process.stdin.setRawMode(true)`) and pipe stdin directly to the PTY
4. Pipe PTY output directly to stdout without any processing for the local terminal path
5. Do NOT parse or modify the byte stream in the local terminal path -- true byte-for-byte transparency
6. Test with: terminal resize during output, Ctrl+C during tool execution, paste of multi-line text, mouse click in Claude Code's UI

**Warning signs:**
- Terminal output appears garbled after window resize
- Ctrl+C kills the proxy instead of sending interrupt to Claude Code
- Arrow keys produce literal `^[[A` characters instead of cursor movement
- Claude Code's progress spinner or status bar renders incorrectly

**Phase to address:**
Phase 1 (local proxy). This is the "transparent" in "transparent proxy" -- if this doesn't work perfectly, the entire product premise fails.

---

## Moderate Pitfalls

### Pitfall 9: Claude Code CLI Is an Unstable Dependency

**What goes wrong:**
Claude Code is actively developed with frequent changes. The `--output-format stream-json` mode has documented bugs. The CLI flags, output schema, and behavior change between versions. Building a product on top of an unstable interface means each Claude Code update can break CC Anywhere.

**How to avoid:**
1. Pin Claude Code versions in documentation and CI testing
2. Build an abstraction layer between the Claude Code interface and CC Anywhere's internal protocol
3. Write integration tests that run against the actual Claude Code CLI
4. Use the Agent SDK (which provides a more stable programmatic interface than the raw CLI) as the primary interface

### Pitfall 10: Taro-Feishu Compilation Incompatibilities

**What goes wrong:**
Taro compiles React code to Feishu's native TTML format. Some React patterns don't translate well. Dynamic styles, complex refs, and certain lifecycle hooks may behave differently.

**How to avoid:**
Prototype the most complex UI component (chat message stream with code blocks) early in development. Use Taro-compatible patterns from the start. Test on real Feishu client, not just the simulator.

### Pitfall 11: Message Size Explosion for Long Sessions

**What goes wrong:**
Claude Code sessions can produce megabytes of output (large file reads, verbose tool outputs). Forwarding all of this to Feishu mini program via WebSocket consumes bandwidth and memory.

**How to avoid:**
Truncate tool output in messages forwarded to Feishu. Send summaries instead of full output for large blocks. Allow user to request full output on demand.

### Pitfall 12: Session State Synchronization Conflicts

**What goes wrong:**
User types on local terminal AND sends a message from Feishu simultaneously. Two inputs reach Claude Code at the same time.

**How to avoid:**
When using the Agent SDK's `streamInput()`, serialize inputs from multiple sources. Consider making one side read-only at a time, or implement input priority (local terminal always wins, remote input queued).

## Minor Pitfalls

### Pitfall 13: strip-ansi ESM-Only

**What goes wrong:** `strip-ansi` v7+ is ESM-only. If any part of the build chain uses CommonJS, imports break.

**Prevention:** Use ESM throughout the project (`"type": "module"` in package.json). tsup can output ESM.

### Pitfall 14: Relay Server Memory Leaks from Abandoned Sessions

**What goes wrong:** Proxy connects, starts a session, then the machine goes to sleep or the network drops. The relay holds session state indefinitely.

**Prevention:** Implement session TTL. Clean up sessions that haven't received a heartbeat in N minutes.

### Pitfall 15: Feishu Developer Tools M-Chip Incompatibility

**What goes wrong:** Feishu Developer Tools documentation mentions it's "not compatible with Apple M chip and requires Rosetta mode."

**Prevention:** Ensure development environment has Rosetta installed. Test early.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Forwarding raw PTY bytes over WebSocket | Fast to implement, "works" in demo | Massive bandwidth, breaks mobile client, ANSI parsing nightmare | Never -- use Agent SDK from the start |
| In-memory session state only | No database dependency | All state lost on proxy restart, no session resume | MVP only, must add persistence before any real usage |
| No message sequence numbers | Simpler protocol | Cannot recover from disconnections, cannot detect message loss | Never -- sequence numbers are cheap to add, expensive to retrofit |
| Hardcoded Claude Code CLI flags | Fast development | Breaks when CLI interface changes | MVP only, must extract to configuration early |
| No approval timeout | Simpler logic | Claude Code hangs forever if mobile user is unreachable | Never -- always implement a timeout, even if generous (30 min) |
| No auth on relay server | Faster development | Anyone on the network can control sessions | MVP in trusted LAN only; must add before any public deployment |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Relay server accessible without authentication | Anyone can connect and control Claude Code sessions | Implement token-based auth on WebSocket handshake. Use a shared secret at minimum. |
| Forwarding arbitrary stdin to Claude Code process | Prompt injection, command execution via tool approval manipulation | Validate input structure; in Agent SDK mode, only forward well-formed SDKUserMessage objects |
| Storing session tokens in Feishu mini program local storage without encryption | Token theft allows session hijacking | Use Feishu's secure storage APIs; implement short-lived tokens with refresh |
| node-pty runs child at same permission level as parent | If proxy runs as root, Claude Code inherits those permissions | Run proxy as unprivileged user; document this requirement |
| Relay server exposes session content in logs | Sensitive code, credentials in output end up in server logs | Log only metadata, never message content |
| No TLS on WebSocket between proxy and relay | Man-in-the-middle on all session traffic | Enforce WSS for all connections |

## "Looks Done But Isn't" Checklist

- [ ] **PTY proxy:** Often missing SIGWINCH handling -- verify by resizing terminal during active Claude Code session
- [ ] **PTY proxy:** Often missing cleanup on crash -- verify by `kill -9` the proxy process and confirming Claude Code child processes also terminate
- [ ] **Agent SDK sessions:** Often missing `query.close()` -- verify no orphaned claude processes after session end
- [ ] **WebSocket relay:** Often missing heartbeat/ping -- verify by disconnecting network for 30s then reconnecting
- [ ] **WebSocket relay:** Often missing backpressure handling -- verify server memory stays bounded under fast message rates
- [ ] **Session management:** Often missing session timeout -- verify resources are reclaimed after 24 hours of inactivity
- [ ] **Tool approval:** Often missing timeout -- verify Claude Code doesn't hang forever on unanswered approval
- [ ] **Feishu mini program:** Often missing app background handling -- verify WebSocket reconnects after switching apps for 2 minutes
- [ ] **Message ordering:** Often missing sequence numbers -- verify display order after simulated packet reordering
- [ ] **Error handling:** Often missing error propagation to mobile -- verify user sees meaningful error when Claude Code crashes
- [ ] **Multi-session:** Often missing session isolation -- verify output from session A never appears in session B

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| TUI redraw flood (Pitfall 1) | Phase 1: Local Proxy | Measure WebSocket bandwidth during streaming; must be <100KB/min for text conversations |
| UTF-8 corruption (Pitfall 2) | Phase 1: Local Proxy | Automated test: stream CJK + emoji through proxy, compare byte-for-byte with direct output |
| Orphaned processes (Pitfall 3) | Phase 1: Local Proxy | After test suite: `pgrep claude` returns only expected processes |
| Message loss on reconnect (Pitfall 4) | Phase 2: Relay Server | Test: disconnect client mid-stream for 10s, reconnect, verify no gaps |
| Tool approval deadlock (Pitfall 5) | Phase 2: Relay Protocol | Test: send approval request, simulate disconnect, verify timeout fires |
| Agent SDK instability (Pitfall 6) | Phase 1: Architecture | Adapter interface defined; integration tests against pinned SDK version |
| Feishu platform constraints (Pitfall 7) | Phase 3: Mini Program | Real device test pass on target Feishu version before feature development |
| Transparent proxy breakage (Pitfall 8) | Phase 1: Local Proxy | Side-by-side comparison: with and without proxy, outputs must be identical |

## Sources

- [node-pty GitHub (microsoft/node-pty)](https://github.com/microsoft/node-pty) - PTY behavior, threading, permissions
- [Claude Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) - canUseTool callback, Query.close(), streaming
- [Claude Agent SDK Migration Guide](https://platform.claude.com/docs/en/agent-sdk/migration-guide) - Package rename, breaking changes
- [Claude Code excessive scroll events (Issue #9935)](https://github.com/anthropics/claude-code/issues/9935) - 4,000-6,700 scrolls/sec rendering data
- [Claude Code stream-json stops (Issue #17248)](https://github.com/anthropics/claude-code/issues/17248) - Known stream-json reliability bug
- [Claude Code headless docs](https://code.claude.com/docs/en/headless) - Programmatic usage, output formats
- [Node.js UTF-8 corruption (nodejs/node#61744)](https://github.com/nodejs/node/issues/61744) - Silent data loss on partial UTF-8 writes
- [Feishu Open Platform docs](https://open.feishu.cn/document?lang=zh-CN) - Mini program development documentation
- [Feishu connectSocket API](https://open.feishu.cn/document/uYjL24iN/ugDMx4COwEjL4ATM) - WebSocket limit (max 5)

---
*Pitfalls research for: CC Anywhere (Claude Code transparent proxy + relay + Feishu mini program)*
*Researched: 2026-04-03*
