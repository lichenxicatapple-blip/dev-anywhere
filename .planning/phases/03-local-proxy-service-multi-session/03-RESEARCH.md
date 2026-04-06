# Phase 3: Proxy Service & Multi-Session (REVISED) - Research

**Researched:** 2026-04-04
**Domain:** Service+client architecture, Unix domain socket IPC, `claude --stream-json` process management, multi-session lifecycle
**Confidence:** HIGH

## Summary

Phase 3 transforms the Phase 2 standalone CLI proxy into a "service + thin client" architecture. A long-running service process (`cc-anywhere serve`) hosts a SessionManager and listens on a Unix domain socket. The CLI client connects to this service, spawns PTY sessions locally (zero terminal latency), and registers them with the service for centralized visibility. JSON sessions (for future remote/headless use) are spawned directly by the service using `claude --output-format stream-json --input-format stream-json --permission-prompt-tool stdio --verbose`.

The architecture is validated by cc-connect (Go reference implementation) which uses the identical `claude --stream-json` approach with pipe-based stdin/stdout JSON communication. cc-connect's `claudeSession` manages the process lifecycle, line-buffered JSON parsing (with non-JSON line skipping), `control_request`/`control_response` for tool approval, and session ID extraction from `system` init events. Our implementation translates these patterns to TypeScript/Node.js.

The key technical challenges are: (1) refactoring PtyManager to not call `process.exit()` on child exit, (2) implementing a reliable line buffer for `--stream-json` stdout parsing (Node.js `data` events split lines arbitrarily), (3) Unix domain socket IPC with a framing protocol for bidirectional message exchange, (4) auto-starting the service daemon from the CLI client, and (5) a reaper timer for orphaned JSON session processes.

**Primary recommendation:** Implement the service as a `node:net` server on a Unix domain socket (`~/.cc-anywhere/cc-anywhere.sock`). Use NDJSON (newline-delimited JSON) over the socket for IPC messages, reusing the shared package's MessageEnvelope schema. The SessionManager maintains `Map<sessionId, SessionInfo>` in memory with JSON file persistence. PTY sessions live in the client process; JSON sessions live in the service process. Auto-start the service via `child_process.spawn` with `detached: true` and `stdio: 'ignore'`, writing a PID file for health checks.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** `cc-anywhere serve` starts a long-running service process with SessionManager, listening on Unix domain socket for CLI client connections.
- **D-02:** `cc-anywhere` (no args or with claude args) runs as thin client: connects to service, requests PTY session creation, bridges terminal I/O to service-managed session.
- **D-03:** CLI client auto-starts service in background if not running (Docker daemon-like behavior).
- **D-04:** PTY managed by client process (not service), ensuring zero terminal latency. Service only does session registration and message relay.
- **D-05:** Drop `@anthropic-ai/claude-agent-sdk`. Use `claude --output-format stream-json --input-format stream-json --permission-prompt-tool stdio --verbose` for JSON sessions.
- **D-06:** This is the cc-connect verified approach: depends only on claude CLI, no SDK dependency, immune to Agent SDK v0.2.x churn.
- **D-07:** `--verbose` is required in pipe mode. stdout may contain non-JSON lines; parse line-by-line with JSON.parse, skip failures (matching cc-connect behavior).
- **D-08:** Long JSON lines may be split across Node.js `data` events; implement line buffering before parsing.
- **D-09:** PTY sessions (mode: "pty"): spawned via node-pty in client process. Phase 2 PtyManager reused. Terminal close ends session.
- **D-10:** JSON sessions (mode: "json"): spawned via `--stream-json` in service process. Structured events for remote consumption. User can close from remote.
- **D-11:** Both modes clearly labeled in session list so user can distinguish terminal vs remote sessions.
- **D-12:** PTY session: client registers with service (id, mode, state). PTY output via tap sideband goes to service, service forwards to relay (Phase 4).
- **D-13:** Feishu can send input to PTY sessions. Service forwards input to client, client writes to PTY stdin.
- **D-14:** Client disconnect (terminal close) notifies service to deregister session. Service marks as terminated.
- **D-15:** SessionManager: `Map<sessionId, SessionInfo>` in memory. SessionInfo: id (nanoid), mode ("pty"|"json"), state (shared SessionState), createdAt, name (optional).
- **D-16:** State machine: idle -> working -> waiting_approval -> idle (cycle), any -> error, any -> terminated.
- **D-17:** JSON file persistence (cc-connect sessionSnapshot pattern). Service restart recovers session metadata.
- **D-18:** API: createSession, listSessions, getSession, terminateSession, terminateAll. Types align with shared Session schemas.
- **D-19:** JSON session tool approval via `--permission-prompt-tool stdio` receives `control_request` events (type: "control_request", subtype: "can_use_tool"). Phase 3 default: deny all.
- **D-20:** Reply via `control_response` JSON on claude stdin. Phase 7 adds remote approval from Feishu.
- **D-21:** Approval strategy is an injectable function for future replacement.
- **D-22:** Service runs 30-second reaper timer for JSON sessions. Checks child process liveness. PTY sessions managed by client.
- **D-23:** Service exit: terminateAll() sends SIGTERM to all JSON session children, SIGKILL after timeout. PTY sessions cleaned by their clients.
- **D-24:** Unix domain socket at `~/.cc-anywhere/cc-anywhere.sock`.
- **D-25:** IPC messages reuse shared MessageEnvelope schema (or subset) for protocol consistency.

### Claude's Discretion
- Unix socket path and permission details
- Service auto-start implementation (fork, spawn, lockfile)
- SessionInfo exact TypeScript type shape
- Reaper timeout and retry parameters
- Line buffer implementation details

### Deferred Ideas (OUT OF SCOPE)
- Relay connection and message bridging -- Phase 4 (RELAY-01)
- Reconnection and message queue caching -- Phase 5 (RELAY-02)
- Feishu mini program UI and remote JSON session creation -- Phase 6 (FEISHU-01, FEISHU-03)
- Remote tool approval workflow -- Phase 7 (FEISHU-02)
- Terminal and mobile dual-surface sync -- Phase 7 (PROXY-04)
- JSON session idle timeout auto-cleanup -- Phase 6 or Phase 10
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PROXY-02 | PTY and JSON channels coexist in parallel without interference | Two distinct session modes (PTY in client, JSON in service) share no process resources. SessionManager tracks both uniformly. IPC protocol keeps them isolated. |
| PROXY-03 | Multi-session management: create, monitor status, terminate, orphan cleanup | SessionManager with Map-based registry, JSON file persistence, state machine, reaper timer, SIGTERM/SIGKILL lifecycle. Directly modeled on cc-connect's SessionManager. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:net` | Node.js built-in | Unix domain socket server/client | Zero dependencies. Part of Node.js core. Provides `createServer()` for IPC with `path` option for Unix sockets. |
| `node:child_process` | Node.js built-in | Spawn `claude --stream-json` child processes for JSON sessions | Standard Node.js process management. `spawn()` with pipe stdio for JSON communication. |
| `node-pty` | ^1.1.0 | PTY management for terminal sessions (in client) | Already used in Phase 2. Microsoft-maintained. Prebuilt binaries. |
| `nanoid` | ^5.1.7 | Session ID generation | Compact, URL-safe, cryptographically secure. 21-char default is collision-resistant for this use case. |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `pino` | ^10.3.1 | Structured JSON logging for service process | Service daemon needs file-based logging since it has no terminal. Pino is the standard high-performance Node.js logger. |
| `commander` | ^14.0.3 | CLI subcommand parsing (`serve`, default client mode) | Phase 3 needs subcommands. Phase 2 had no commander dependency (all args passed through). Now `cc-anywhere serve` vs `cc-anywhere [claude-args]` requires routing. |

### Not Needed (Removed from Previous Research)
| Library | Reason Removed |
|---------|---------------|
| `@anthropic-ai/claude-agent-sdk` | Replaced by `claude --stream-json` per D-05. No SDK dependency. |
| `reconnecting-websocket` | Phase 4 concern, not Phase 3. |
| `strip-ansi` | Not needed until relay integration. |

**Installation:**
```bash
# In apps/proxy
pnpm add nanoid pino commander
pnpm add -D @types/node
```

**Version verification:**
- nanoid: 5.1.7 (current on npm)
- pino: 10.3.1 (current on npm)
- commander: 14.0.3 (current on npm)
- node-pty: 1.1.0 (already installed)

## Architecture Patterns

### Recommended Project Structure
```
apps/proxy/src/
  index.ts              # CLI entry point (commander routing: serve vs client)
  client.ts             # Thin client: connect to service, create PTY session, bridge I/O
  serve.ts              # Service entry: start Unix socket server, SessionManager, reaper
  session-manager.ts    # SessionManager class with Map, persistence, CRUD API
  json-session.ts       # JSON session: spawn claude --stream-json, parse events, handle control
  line-buffer.ts        # Line buffer utility for splitting data events into complete lines
  ipc-protocol.ts       # IPC message types, framing, serialize/deserialize over socket
  pty-manager.ts        # Refactored PtyManager (remove process.exit, add event callbacks)
  tap.ts                # DataTap interface (unchanged from Phase 2)
  __tests__/
    session-manager.test.ts
    json-session.test.ts
    line-buffer.test.ts
    ipc-protocol.test.ts
    pty-manager.test.ts   # Updated for refactored PtyManager
```

### Pattern 1: Service + Thin Client (Docker Daemon Pattern)

**What:** The service runs as a background daemon. The CLI client checks if the service is alive (try connecting to socket), auto-starts it if not, then communicates via IPC.

**When to use:** Always -- this is the core architecture for Phase 3.

**Implementation approach:**
```typescript
// client.ts -- service auto-start
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";

const SOCK_PATH = `${process.env.HOME}/.cc-anywhere/cc-anywhere.sock`;
const PID_PATH = `${process.env.HOME}/.cc-anywhere/cc-anywhere.pid`;

function tryConnect(): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const sock = connect(SOCK_PATH);
    sock.on("connect", () => resolve(sock));
    sock.on("error", () => resolve(null));
  });
}

async function ensureService(): Promise<net.Socket> {
  let sock = await tryConnect();
  if (sock) return sock;

  // Auto-start service
  const child = spawn(process.execPath, [/* path to serve entry */], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Wait for socket to become available (poll with backoff)
  for (let i = 0; i < 20; i++) {
    await sleep(100 * (i + 1));
    sock = await tryConnect();
    if (sock) return sock;
  }
  throw new Error("Failed to start cc-anywhere service");
}
```

### Pattern 2: NDJSON IPC Framing over Unix Socket

**What:** Messages are serialized as newline-delimited JSON over the Unix domain socket. Each message is one JSON object followed by `\n`. The line buffer handles partial reads.

**When to use:** All IPC communication between client and service.

**Why NDJSON over length-prefixed framing:** Simpler to implement and debug. Human-readable with `socat`. Consistent with the `claude --stream-json` protocol itself. The shared MessageEnvelope schema already maps naturally to JSON objects.

```typescript
// ipc-protocol.ts
import { Transform, type TransformCallback } from "node:stream";

// Splits incoming socket data into complete lines
export class LineTransform extends Transform {
  private buffer = "";

  _transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
    this.buffer += chunk.toString();
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop()!; // keep incomplete last segment
    for (const line of lines) {
      if (line.trim()) {
        this.push(line);
      }
    }
    callback();
  }

  _flush(callback: TransformCallback): void {
    if (this.buffer.trim()) {
      this.push(this.buffer);
    }
    this.buffer = "";
    callback();
  }
}
```

### Pattern 3: JSON Session Process Management (cc-connect Pattern)

**What:** Spawn `claude` with `--stream-json` flags, read structured JSON events from stdout, write user messages and control responses to stdin. Parse line-by-line, skip non-JSON.

**When to use:** All JSON (remote/headless) sessions.

**Key reference:** `reference/cc-connect/agent/claudecode/session.go` lines 44-203.

```typescript
// json-session.ts -- core pattern from cc-connect
import { spawn, type ChildProcess } from "node:child_process";

const CLAUDE_ARGS = [
  "--output-format", "stream-json",
  "--input-format", "stream-json",
  "--permission-prompt-tool", "stdio",
  "--verbose",
];

// Spawn claude with JSON streaming
function spawnClaudeJson(workDir: string): ChildProcess {
  const child = spawn("claude", CLAUDE_ARGS, {
    cwd: workDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: filterEnv(process.env, "CLAUDECODE"), // cc-connect pattern: remove CLAUDECODE to prevent nested detection
  });
  return child;
}

// Read loop: line-buffered JSON parsing with non-JSON skip
function processStdout(child: ChildProcess, onEvent: (event: StreamJsonEvent) => void): void {
  let buffer = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        onEvent(parsed);
      } catch {
        // Non-JSON line (verbose output), skip -- per D-07
      }
    }
  });
}
```

### Pattern 4: SessionManager with JSON Persistence (cc-connect Pattern)

**What:** In-memory `Map<string, SessionInfo>` with JSON file snapshot for service restart recovery.

**Key reference:** `reference/cc-connect/core/session.go` lines 162-541.

```typescript
// session-manager.ts -- simplified from cc-connect
interface SessionInfo {
  id: string;           // nanoid
  mode: "pty" | "json";
  state: SessionState;  // from shared package
  createdAt: number;    // Date.now()
  name?: string;
  claudeSessionId?: string; // from stream-json system init event
  pid?: number;         // child process PID (json sessions only)
}

interface SessionSnapshot {
  sessions: Record<string, SessionInfo>;
  counter: number;
}
```

### Pattern 5: PtyManager Refactoring (Event-Based Exit)

**What:** Replace `process.exit()` in `onExit` callback with an event emitter or callback function. The caller (client.ts) decides what to do when a PTY session ends.

**Key change:** `pty-manager.ts` line 77-87. Instead of `process.exit(code)`, emit an event or invoke a callback. The existing test that verifies `process.exit` behavior must be updated.

```typescript
// Before (Phase 2):
child.onExit(({ exitCode, signal }) => {
  // ...restore raw mode...
  const code = signal ? 128 + signal : exitCode;
  process.exit(code); // KILLS ENTIRE PROCESS
});

// After (Phase 3):
child.onExit(({ exitCode, signal }) => {
  // ...restore raw mode...
  const code = signal ? 128 + signal : exitCode;
  this.onSessionExit?.(code); // CALLBACK, caller decides
});
```

### Anti-Patterns to Avoid

- **Service managing PTY processes:** PTY must stay in client for zero latency (D-04). Service never spawns node-pty.
- **Agent SDK as fallback:** D-05 is a hard decision. Do not import or use `@anthropic-ai/claude-agent-sdk` anywhere.
- **Length-prefixed binary framing for IPC:** Overengineered for this use case. NDJSON is simpler, debuggable, consistent with stream-json protocol.
- **WebSocket for local IPC:** Unix domain socket is faster, simpler, no HTTP upgrade overhead. WebSocket is for relay (Phase 4).
- **Polling for service readiness:** Use connect-retry loop with exponential backoff, not filesystem polling on PID file.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Session IDs | Custom UUID or counter | `nanoid` | Cryptographic randomness, URL-safe, compact (21 chars), zero config |
| Line buffering for streams | Manual string.split in data handler | Dedicated `LineTransform` class (or `readline` module) | Edge cases with partial UTF-8, empty lines, trailing newlines. The readline approach is well-tested. |
| Process daemonization | Custom fork/detach logic | `child_process.spawn` with `detached: true, stdio: 'ignore'` + `child.unref()` | Node.js built-in daemonization pattern. Adding a PID file is straightforward. |
| CLI subcommand routing | Manual `process.argv` parsing | `commander` | Phase 3 needs `serve` subcommand, default client mode, help text. Commander handles this cleanly. |
| Structured logging | `console.log` with prefixes | `pino` | Service daemon logs to file. Pino provides JSON structured logging, log levels, child loggers for session context. |
| Atomic file writes (persistence) | Direct `fs.writeFileSync` | Write to temp file then `fs.renameSync` | Prevents corrupt snapshot on crash mid-write. cc-connect uses `AtomicWriteFile` for exactly this. |

**Key insight:** The `claude --stream-json` protocol is already well-proven by cc-connect. Our job is to faithfully translate cc-connect's Go patterns to TypeScript, not to reinvent the protocol handling.

## Common Pitfalls

### Pitfall 1: Node.js Data Events Split JSON Lines
**What goes wrong:** `child.stdout.on("data", ...)` delivers arbitrary chunks. A single JSON line from `claude --stream-json` may arrive across 2+ data events, especially for long assistant messages or tool call inputs.
**Why it happens:** Node.js streams chunk at kernel pipe buffer boundaries (typically 64KB on macOS/Linux). Long JSON objects (e.g., file content in tool results) easily exceed this.
**How to avoid:** Always use a line buffer that accumulates data until `\n` is found, then emits complete lines. The cc-connect reference uses Go's `bufio.Scanner` (line 159-163) with a 10MB max buffer. Our TypeScript equivalent is a `LineTransform` stream or manual buffer accumulation.
**Warning signs:** `JSON.parse` errors on seemingly valid stream-json output. Errors that appear only with large files or long responses.

### Pitfall 2: Stale Unix Socket File After Unclean Shutdown
**What goes wrong:** If the service crashes without cleaning up, `~/.cc-anywhere/cc-anywhere.sock` remains on disk. The next `net.createServer().listen(SOCK_PATH)` fails with `EADDRINUSE`.
**Why it happens:** Unix domain sockets create a filesystem entry. Node.js `net.Server` does not auto-clean on crash.
**How to avoid:** On service startup: (1) check if socket file exists, (2) try connecting to it -- if connection succeeds, another service is running (exit with message), (3) if connection fails (ECONNREFUSED), the socket is stale -- `fs.unlinkSync` it and proceed. Also write a PID file and verify PID is alive.
**Warning signs:** Service fails to start with "address already in use" after a crash or `kill -9`.

### Pitfall 3: process.exit() in PtyManager Kills Multi-Session Service
**What goes wrong:** Phase 2's PtyManager calls `process.exit(code)` when the PTY child exits (line 87). In a multi-session context, one session ending kills the entire client process, terminating all other sessions.
**Why it happens:** Phase 2 assumed one PTY = one process. This assumption no longer holds.
**How to avoid:** Refactor PtyManager to use an exit callback instead of `process.exit()`. The client's main loop invokes `process.exit()` only when all sessions are done and the user wants to quit.
**Warning signs:** All PTY sessions terminate when any single session exits.

### Pitfall 4: CLAUDECODE Environment Variable Causes Nested Session Detection
**What goes wrong:** Claude Code sets `CLAUDECODE` in its own environment. If we spawn a `claude --stream-json` child from within a Claude Code session (during development), the child detects the env var and refuses to start, thinking it's a nested session.
**Why it happens:** Claude Code's anti-nesting protection.
**How to avoid:** Filter `CLAUDECODE` from the child's environment, exactly as cc-connect does (session.go line 96-97: `filterEnv(os.Environ(), "CLAUDECODE")`).
**Warning signs:** JSON sessions fail to start with a "nested session" error during development.

### Pitfall 5: control_response Format Must Exactly Match
**What goes wrong:** Sending a malformed `control_response` to claude stdin causes it to hang or crash. The response structure is specific and underdocumented.
**Why it happens:** The `--permission-prompt-tool stdio` protocol has a precise JSON schema that is not fully documented in official docs.
**How to avoid:** Follow cc-connect's verified format exactly (session.go lines 500-507):
```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "<from control_request>",
    "response": {
      "behavior": "allow",
      "updatedInput": {}
    }
  }
}
```
For deny:
```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "<from control_request>",
    "response": {
      "behavior": "deny",
      "message": "The user denied this tool use."
    }
  }
}
```
**Warning signs:** JSON sessions hang at tool approval step. Claude process exits unexpectedly after receiving a control_response.

### Pitfall 6: Service Auto-Start Race Condition
**What goes wrong:** Two CLI clients launch simultaneously, both detect no service, both try to start one. Two service processes fight over the socket.
**Why it happens:** No atomicity between "check if service exists" and "start service".
**How to avoid:** Use a lock file (`~/.cc-anywhere/cc-anywhere.lock`) with `fs.openSync` using `O_CREAT | O_EXCL` flag for atomic creation. The process that wins the lock starts the service; the loser retries connection. Alternatively, just retry connecting after a short delay -- the first service to bind the socket wins, the second fails harmlessly.
**Warning signs:** Intermittent "address already in use" errors on first launch. Two service processes running simultaneously.

### Pitfall 7: Forgetting stdin Mutex for JSON Session Writes
**What goes wrong:** Multiple callers (user message + control_response) write to the claude process stdin concurrently. Interleaved writes produce invalid JSON.
**Why it happens:** Node.js `Writable.write()` does not guarantee atomicity for individual calls when multiple writes are queued.
**How to avoid:** Use a write mutex (or sequential queue) for stdin writes, matching cc-connect's `stdinMu sync.Mutex` (session.go line 30). In Node.js, a simple promise-based queue suffices since we're single-threaded.
**Warning signs:** Corrupted JSON lines in claude's stdin. Claude process crashes with parse errors.

## Code Examples

### stream-json Event Types (from cc-connect + verified test script)

The `claude --stream-json` output emits these top-level event types:

```typescript
// Verified from cc-connect session.go handleSystem/handleAssistant/handleResult/handleControlRequest
// and reference/test-stream-json.mjs

type StreamJsonEventType =
  | "system"           // Init event: contains session_id, tools, model
  | "assistant"        // Assistant turn: message.content[] with text, tool_use, thinking blocks
  | "user"             // User turn echo: message.content[] with tool_result blocks
  | "result"           // Turn complete: result text, session_id, usage (input/output tokens)
  | "control_request"  // Permission request: request.subtype "can_use_tool", tool_name, input
  | "control_cancel_request"  // Permission cancelled
  | "stream_event";    // Low-level streaming deltas (with --include-partial-messages)

// system init event structure
interface SystemInitEvent {
  type: "system";
  subtype: "init";
  session_id: string;
  tools: unknown[];
  model: string;
  // ...other fields
}

// control_request event structure (from cc-connect session.go line 326-340)
interface ControlRequestEvent {
  type: "control_request";
  request_id: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: Record<string, unknown>;
  };
}

// User message format for stdin (from cc-connect session.go line 392-401)
interface UserMessageInput {
  type: "user";
  message: {
    role: "user";
    content: string | ContentBlock[];
  };
}
```

### Service Auto-Start with PID File

```typescript
// Recommended approach for service lifecycle
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { connect, createServer } from "node:net";

const CC_DIR = `${process.env.HOME}/.cc-anywhere`;
const SOCK_PATH = `${CC_DIR}/cc-anywhere.sock`;
const PID_PATH = `${CC_DIR}/cc-anywhere.pid`;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = check existence only
    return true;
  } catch {
    return false;
  }
}

function cleanupStaleSocket(): void {
  if (!existsSync(SOCK_PATH)) return;

  // Check PID file
  if (existsSync(PID_PATH)) {
    const pid = parseInt(readFileSync(PID_PATH, "utf8"), 10);
    if (isProcessAlive(pid)) {
      throw new Error(`Service already running (PID ${pid})`);
    }
    unlinkSync(PID_PATH);
  }
  unlinkSync(SOCK_PATH);
}

function startService(): void {
  mkdirSync(CC_DIR, { recursive: true });
  cleanupStaleSocket();

  const server = createServer((socket) => {
    // Handle IPC connections
  });

  server.listen(SOCK_PATH, () => {
    writeFileSync(PID_PATH, String(process.pid));
    // Socket permissions: only owner can connect
  });

  // Cleanup on exit
  function cleanup(): void {
    try { unlinkSync(SOCK_PATH); } catch {}
    try { unlinkSync(PID_PATH); } catch {}
  }
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
}
```

### Reaper Timer for Orphaned Processes

```typescript
// cc-connect checks process liveness; we translate to Node.js
function startReaper(sessionManager: SessionManager, intervalMs = 30_000): NodeJS.Timeout {
  return setInterval(() => {
    for (const session of sessionManager.listJsonSessions()) {
      if (session.pid && !isProcessAlive(session.pid)) {
        logger.warn({ sessionId: session.id, pid: session.pid }, "Reaping orphaned session");
        sessionManager.markTerminated(session.id);
      }
    }
  }, intervalMs);
}
```

### Session Termination with Grace Period

```typescript
// SIGTERM -> wait -> SIGKILL pattern (from cc-connect session.go Close() lines 565-579)
async function terminateProcess(pid: number, gracePeriodMs = 5000): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // Already dead
  }

  const deadline = Date.now() + gracePeriodMs;
  while (Date.now() < deadline) {
    await sleep(200);
    if (!isProcessAlive(pid)) return;
  }

  // Grace period expired, force kill
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already dead
  }
}
```

## State of the Art

| Old Approach (Previous Research) | Current Approach (Revised) | Why Changed | Impact |
|----------------------------------|---------------------------|-------------|--------|
| Agent SDK `query()` for remote sessions | `claude --stream-json` child process | Agent SDK v0.2.x instability. cc-connect proves stream-json is mature and sufficient. | Eliminates SDK dependency entirely. Simpler process model. |
| Standalone CLI with polymorphic sessions | Service + thin client architecture | Need centralized session visibility for relay (Phase 4) and Feishu (Phase 6). | Service becomes the single source of truth for all sessions. |
| PtySession wrapping node-pty directly | PtyManager refactored with callbacks | PTY stays in client process (D-04). PtyManager already works, just needs process.exit() removed. | Less new code; reuse Phase 2 investment. |
| Single entry point | Commander with `serve` subcommand | Two distinct runtime modes (service daemon vs client CLI). | Clean separation of concerns. |

**Deprecated/outdated:**
- `@anthropic-ai/claude-agent-sdk`: Removed from project. Not used in Phase 3 or beyond.
- Previous RESEARCH.md: Based entirely on Agent SDK. Fully superseded by this document.

## Open Questions

1. **Socket file permissions**
   - What we know: Unix domain sockets inherit umask. Default umask 022 allows group/other read.
   - What's unclear: Whether we need `fs.chmodSync(SOCK_PATH, 0o600)` for security (only owner access).
   - Recommendation: Set socket to 0o600 after creation. This is a personal developer tool, not a multi-user server.

2. **Service log location**
   - What we know: Daemon has no terminal. Pino can write to file or stdout (redirected to /dev/null when detached).
   - What's unclear: Best practice for log rotation in a personal dev tool.
   - Recommendation: Log to `~/.cc-anywhere/service.log`. Keep it simple; no rotation for v1. Users can delete manually.

3. **IPC protocol: full MessageEnvelope vs lightweight subset**
   - What we know: D-25 says reuse MessageEnvelope "or subset". Full envelope has seq, sessionId, timestamp, source, version -- some fields are relay-oriented (seq for replay).
   - What's unclear: Whether the overhead of full envelope validation is justified for local IPC.
   - Recommendation: Use full MessageEnvelope. The overhead is negligible (single JSON parse + zod validation). Keeps protocol consistent from IPC through relay. Avoids maintaining two protocol variants.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.2 |
| Config file | `apps/proxy/vitest.config.ts` |
| Quick run command | `pnpm vitest run --project proxy` |
| Full suite command | `pnpm vitest run` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PROXY-02 | PTY and JSON sessions coexist without interference | integration | `pnpm vitest run --project proxy -- src/__tests__/session-manager.test.ts` | Wave 0 |
| PROXY-03a | Create multiple concurrent sessions | unit | `pnpm vitest run --project proxy -- src/__tests__/session-manager.test.ts` | Wave 0 |
| PROXY-03b | Session state monitoring (idle/working/waiting_approval/error/terminated) | unit | `pnpm vitest run --project proxy -- src/__tests__/session-manager.test.ts` | Wave 0 |
| PROXY-03c | Graceful session termination (SIGTERM + SIGKILL) | unit | `pnpm vitest run --project proxy -- src/__tests__/json-session.test.ts` | Wave 0 |
| PROXY-03d | Orphan reaper detects dead processes | unit | `pnpm vitest run --project proxy -- src/__tests__/session-manager.test.ts` | Wave 0 |
| PROXY-03e | JSON persistence and recovery | unit | `pnpm vitest run --project proxy -- src/__tests__/session-manager.test.ts` | Wave 0 |
| N/A | Line buffer handles split data events | unit | `pnpm vitest run --project proxy -- src/__tests__/line-buffer.test.ts` | Wave 0 |
| N/A | IPC protocol serialization/deserialization | unit | `pnpm vitest run --project proxy -- src/__tests__/ipc-protocol.test.ts` | Wave 0 |
| N/A | PtyManager exit callback (no process.exit) | unit | `pnpm vitest run --project proxy -- src/__tests__/pty-manager.test.ts` | Exists, needs update |

### Sampling Rate
- **Per task commit:** `pnpm vitest run --project proxy`
- **Per wave merge:** `pnpm vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `apps/proxy/src/__tests__/session-manager.test.ts` -- covers PROXY-02, PROXY-03a/b/d/e
- [ ] `apps/proxy/src/__tests__/json-session.test.ts` -- covers PROXY-03c, stream-json parsing, control_request/response
- [ ] `apps/proxy/src/__tests__/line-buffer.test.ts` -- covers line splitting edge cases
- [ ] `apps/proxy/src/__tests__/ipc-protocol.test.ts` -- covers NDJSON framing over socket
- [ ] `apps/proxy/src/__tests__/pty-manager.test.ts` -- EXISTS but needs update for callback-based exit

## Project Constraints (from CLAUDE.md)

- Log messages in code MUST be in English
- Comments and docstrings in Chinese
- No emoji in code
- No lazy imports unless circular dependency exists
- All imports at file top
- Use `rmtrash` instead of `rm`
- Prefer reusable script files over one-off `python -c` commands
- Avoid hardcoded directory paths; use config or parameters
- Errors must be thrown explicitly, no silent fallbacks
- Git commit messages must be concise one-liners (no Co-Authored-By, no test counts)
- Do not add unnecessary compatibility layers during refactoring
- Delete dead code after migration
- Reuse existing code and patterns; avoid reinventing the wheel

## Sources

### Primary (HIGH confidence)
- `reference/cc-connect/agent/claudecode/session.go` -- Complete `claude --stream-json` process management, event parsing, control_request/control_response protocol. Verified working implementation.
- `reference/cc-connect/agent/claudecode/claudecode.go` -- Agent interface, StartSession pattern, session flags (--resume, --continue, --fork-session).
- `reference/cc-connect/core/session.go` -- SessionManager with JSON persistence, session CRUD, snapshot save/load.
- `reference/cc-connect/core/interfaces.go` -- Agent/AgentSession/PermissionResult interface definitions.
- `reference/test-stream-json.mjs` -- Local verification that `claude --stream-json` works via Node.js child_process.
- [Node.js net module docs](https://nodejs.org/api/net.html) -- Unix domain socket server/client API.
- [Claude Code headless mode docs](https://code.claude.com/docs/en/headless) -- `--output-format stream-json`, `--verbose`, streaming usage.

### Secondary (MEDIUM confidence)
- [GitHub Issue #24596](https://github.com/anthropics/claude-code/issues/24596) -- stream-json event type documentation gaps. Confirms event types but notes they're underdocumented.
- [GitHub Issue #24594](https://github.com/anthropics/claude-code/issues/24594) -- `--input-format stream-json` usage. Reverse-engineered message format matches cc-connect's implementation.
- [npm: nanoid](https://www.npmjs.com/package/nanoid) -- v5.1.7 current.
- [npm: pino](https://www.npmjs.com/package/pino) -- v10.3.1 current.
- [npm: commander](https://www.npmjs.com/package/commander) -- v14.0.3 current.

### Tertiary (LOW confidence)
- [npm: auto-daemon](https://www.npmjs.com/package/auto-daemon) -- Inspiration for auto-start pattern, but we hand-roll since it's a simple spawn+PID file. Not used directly.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- All libraries are well-known Node.js ecosystem standards. No exotic dependencies.
- Architecture: HIGH -- Service+client pattern is proven (Docker, git daemon). cc-connect validates the `--stream-json` approach in production.
- Pitfalls: HIGH -- Most pitfalls derived from cc-connect's actual implementation choices (line buffering, CLAUDECODE filtering, stdin mutex, stale socket cleanup).
- stream-json protocol: MEDIUM -- Official docs are thin (acknowledged by Issues #24596 and #24594). However, cc-connect provides a complete working reference, and our own `test-stream-json.mjs` confirms basic operation.

**Research date:** 2026-04-04
**Valid until:** 2026-05-04 (30 days -- the `claude --stream-json` protocol may change, but cc-connect tracks changes actively)
