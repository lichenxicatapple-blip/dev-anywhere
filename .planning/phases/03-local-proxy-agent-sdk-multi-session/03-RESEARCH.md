# Phase 3: Local Proxy - Agent SDK & Multi-Session - Research

**Researched:** 2026-04-03
**Domain:** Agent SDK integration, multi-session process management, TypeScript
**Confidence:** HIGH

## Summary

Phase 3 adds two capabilities to the existing PTY proxy: (1) an Agent SDK-driven session mode for structured remote control, and (2) a SessionManager that manages multiple concurrent Claude Code sessions of both types (PTY and SDK). The existing PtyManager from Phase 2 is reused for PTY sessions. SDK sessions use `@anthropic-ai/claude-agent-sdk`'s `query()` function with streaming input mode (`AsyncGenerator<SDKUserMessage>`) to drive Claude Code headlessly. The SessionManager unifies both session types behind a consistent TypeScript API, tracks state using the shared package's `SessionState` enum, and handles lifecycle including creation, status monitoring, graceful termination, and orphan process cleanup via a periodic reaper.

The Agent SDK (v0.2.91, current on npm) provides all the primitives needed: `query()` returns a `Query` object that is both an `AsyncGenerator<SDKMessage>` and has a `close()` method for forceful termination. The `canUseTool` callback receives tool name, input, and a unique `toolUseID`, and returns a Promise that blocks SDK execution until resolved -- this maps directly to the future remote approval flow (Phase 7). Streaming input via `AsyncGenerator<SDKUserMessage>` supports multi-turn conversations where messages can be injected from external sources. Each `query()` call spawns a separate Claude Code child process internally, so PTY sessions and SDK sessions never share processes and cannot interfere with each other.

The key architectural challenge is the PtyManager's `process.exit()` call on child exit (line 87 of pty-manager.ts). In a multi-session context, one PTY session ending must not kill the entire proxy. The solution is to create a new PtySession class that wraps node-pty directly with multi-session-safe lifecycle handling, keeping PtyManager unchanged for backward compatibility with the single-session CLI entry path.

**Primary recommendation:** Implement SessionManager as a `Map<string, Session>` with polymorphic session types (PtySession wrapping node-pty directly, SdkSession wrapping Agent SDK `query()`). Use `nanoid` for session IDs. Register a 30-second interval reaper that checks `kill(pid, 0)` on tracked processes. On SessionManager disposal, SIGTERM all children with a 5-second grace period before SIGKILL.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** PTY sessions and SDK sessions run independent claude child processes, no process sharing. PTY uses node-pty spawn (Phase 2 PtyManager), SDK uses ClaudeClient/query() in headless mode.
- **D-02:** Both session types managed through unified SessionManager with consistent interface (create, query, terminate). Internal dispatch by mode.
- **D-03:** Phase 2 tap points preserved. PTY data flows through tap. SDK data comes from structured event stream, not through tap.
- **D-04:** SessionManager uses `Map<sessionId, Session>` in memory. Session has: id (nanoid), mode ("pty" | "sdk"), state (SessionState enum from shared), process reference, createdAt, optional name.
- **D-05:** State machine: idle -> working -> waiting_approval -> idle (cycle), any -> error, any -> terminated.
- **D-06:** Sessions fully isolated. No shared state between sessions.
- **D-07:** Phase 3 only exposes programmatic TypeScript API (SessionManager class methods). No CLI subcommands, no HTTP endpoints.
- **D-08:** API: createSession(mode, options?), listSessions(), getSession(id), terminateSession(id), terminateAll().
- **D-09:** 30-second interval reaper timer, checks `kill(pid, 0)` for liveness.
- **D-10:** Dead process detected -> mark terminated, remove from active map, release resources.
- **D-11:** On SessionManager destroy (process exit): terminateAll() with SIGTERM, short timeout, then SIGKILL for survivors.
- **D-12:** SDK sessions implement canUseTool callback. Phase 3 default: deny all.
- **D-13:** canUseTool designed as injectable strategy function, replaced in Phase 7 with remote approval.

### Claude's Discretion
- Agent SDK ClaudeClient initialization config (model, systemPrompt, etc.)
- Session interface precise TypeScript type design
- Reaper timeout and retry parameters
- SDK session error recovery and retry strategy

### Deferred Ideas (OUT OF SCOPE)
- Relay connection and message bridging -- Phase 4 (RELAY-01)
- Disconnect reconnection and message queue caching -- Phase 5 (RELAY-02)
- Feishu mini program UI -- Phase 6 (FEISHU-01)
- Remote tool approval flow -- Phase 7 (FEISHU-02)
- Terminal and mobile dual-surface sync -- Phase 7 (PROXY-04)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PROXY-02 | PTY channel and Agent SDK channel run in parallel without interference, PTY for local terminal, SDK for structured remote control | Agent SDK `query()` spawns independent claude child processes internally. PTY sessions use node-pty. No process sharing = no interference. Verified via official SDK docs: each `query()` call creates its own process. Session isolation guaranteed by D-06. |
| PROXY-03 | Multiple concurrent sessions with independent operation, status reporting, individual termination, orphan cleanup | SessionManager with `Map<string, Session>`, nanoid IDs, SessionState enum from shared package, `kill(pid, 0)` reaper every 30s, SIGTERM+SIGKILL cleanup on destroy. All patterns verified against Node.js process APIs and SDK `Query.close()` docs. |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- Code logs in English, comments and docstrings in Chinese
- No emoji in code
- No delayed imports unless circular dependency exists
- No silent fallback handling, throw errors explicitly
- Use `rmtrash` instead of `rm`
- Avoid unnecessary adapter/wrapper layers -- direct modifications preferred during refactoring
- git commit messages concise, no co-author/test-count info
- Reuse existing code patterns, avoid reinventing

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@anthropic-ai/claude-agent-sdk` | 0.2.91 | Programmatic Claude Code control for SDK sessions | First-party SDK. Provides structured streaming, canUseTool callback, session management. Verified current on npm: 0.2.91 (2026-04-03). |
| `node-pty` | ^1.1.0 | PTY session mode (already installed) | Already in use from Phase 2. No changes needed. |
| `nanoid` | ^5.1.7 | Session ID generation | Compact, URL-safe, collision-resistant. Verified current on npm: 5.1.7 (2026-04-03). ESM-only, matches project "type": "module" setup. |

### Supporting (already in project)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@cc-anywhere/shared` | workspace:* | SessionState enum, Session schemas, MessageEnvelope types | All session state and type definitions |
| `vitest` | ^2.x | Testing framework | Unit tests for SessionManager and SdkSession |

### New Dependencies for apps/proxy/package.json
Only `@anthropic-ai/claude-agent-sdk` and `nanoid` are new production dependencies. Everything else is already available.

**Installation:**
```bash
cd apps/proxy && pnpm add @anthropic-ai/claude-agent-sdk@0.2.91 nanoid@^5.1.7
```

**Version verification:**
- `@anthropic-ai/claude-agent-sdk`: 0.2.91 (verified via `npm view` 2026-04-03)
- `nanoid`: 5.1.7 (verified via `npm view` 2026-04-03)
- `node-pty`: ^1.1.0 (already installed, Phase 2)

## Architecture Patterns

### Recommended Project Structure (Phase 3 additions to apps/proxy/src/)
```
apps/proxy/src/
  index.ts              # entry point (refactored: SessionManager-driven for multi-session,
                        #   PtyManager fallback for single-session CLI)
  pty-manager.ts        # existing Phase 2 PTY manager (unchanged)
  tap.ts                # existing data tap (unchanged)
  session-manager.ts    # NEW: multi-session lifecycle manager
  sdk-session.ts        # NEW: Agent SDK session wrapper implementing Session interface
  pty-session.ts        # NEW: node-pty session wrapper implementing Session interface
  types.ts              # NEW: Session interface, SessionMode type, creation options
  __tests__/
    pty-manager.test.ts       # existing (unchanged)
    session-manager.test.ts   # NEW: SessionManager unit tests
    sdk-session.test.ts       # NEW: SDK session unit tests
    pty-session.test.ts       # NEW: PTY session unit tests
```

### Pattern 1: Polymorphic Session Interface

**What:** Define a `Session` interface that both PtySession and SdkSession implement. SessionManager operates on this interface without knowing implementation details.

**When to use:** All session operations go through SessionManager, which delegates to the correct implementation based on mode.

**Example:**
```typescript
// types.ts
import type { SessionState } from "@cc-anywhere/shared";

export type SessionMode = "pty" | "sdk";

export interface SessionCreateOptions {
  name?: string;
  cwd?: string;
  claudeArgs?: string[];
}

export interface Session {
  readonly id: string;
  readonly mode: SessionMode;
  readonly createdAt: number;
  name?: string;
  state: SessionState;
  // 子进程 PID，用于 reaper 存活检测
  readonly pid: number | undefined;
  // 终止会话并清理资源
  terminate(): Promise<void>;
  // 检测子进程是否存活
  isAlive(): boolean;
}

// SessionManager 返回类型，对齐 shared 包的 SessionListPayload
export interface SessionInfo {
  sessionId: string;
  name?: string;
  mode: SessionMode;
  state: SessionState;
  createdAt: number;
}
```

### Pattern 2: Agent SDK Session Wrapper (SdkSession)

**What:** Wraps a single `query()` call and its returned `Query` object. Manages the streaming input channel, message iteration, and cleanup.

**When to use:** Creating SDK-mode sessions for headless Claude Code control.

**Key SDK API surface (from official docs):**
```typescript
// query() 接口
function query({
  prompt,
  options
}: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query;

// Query 对象 -- extends AsyncGenerator<SDKMessage> 并附加控制方法
interface Query extends AsyncGenerator<SDKMessage, void> {
  close(): void;           // 终止底层进程，释放所有资源
  interrupt(): Promise<void>;  // 中断当前操作（仅 streaming input 模式）
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
}

// SDKUserMessage -- 注入到 streaming input 的消息格式
type SDKUserMessage = {
  type: "user";
  uuid?: string;
  session_id: string;
  message: MessageParam;  // Anthropic SDK 的 MessageParam
  parent_tool_use_id: string | null;
};

// canUseTool 回调签名
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];
    toolUseID: string;
    decisionReason?: string;
  }
) => Promise<PermissionResult>;

// PermissionResult -- allow 或 deny
type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string };
```

**SdkSession implementation pattern:**
```typescript
// sdk-session.ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Query, SDKUserMessage, SDKMessage, CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { nanoid } from "nanoid";
import { SessionState } from "@cc-anywhere/shared";

// 可从外部注入消息的输入通道
function createInputChannel() {
  const queue: SDKUserMessage[] = [];
  let resolve: (() => void) | null = null;
  let closed = false;

  async function* gen(): AsyncGenerator<SDKUserMessage> {
    while (!closed) {
      if (queue.length === 0) {
        await new Promise<void>((r) => { resolve = r; });
        resolve = null;
      }
      while (queue.length > 0) {
        yield queue.shift()!;
      }
    }
  }

  return {
    generator: gen(),
    push(msg: SDKUserMessage) {
      queue.push(msg);
      resolve?.();
    },
    close() {
      closed = true;
      resolve?.();
    },
  };
}

// SdkSession 实现 Session 接口
// query() 内部会 spawn claude 进程，pid 可从 init 消息中获取 session_id
// close() 终止底层进程
```

### Pattern 3: PtySession (multi-session-safe node-pty wrapper)

**What:** A new class wrapping node-pty directly, implementing the Session interface. Unlike PtyManager, it does NOT call `process.exit()` on child exit.

**Why not reuse PtyManager:** PtyManager's `onExit` handler (line 77-87) calls `process.exit()`, which is correct for single-session CLI mode but fatal in multi-session mode. PtyManager also takes stdin/stdout directly and sets raw mode, which doesn't work when multiple PTY sessions share the same terminal.

**When to use:** Creating PTY-mode sessions through SessionManager.

**Key difference from PtyManager:**
```typescript
// PtyManager (Phase 2) -- single session, owns process lifecycle:
child.onExit(({ exitCode, signal }) => {
  // ...
  process.exit(code);  // kills entire proxy
});

// PtySession (Phase 3) -- multi-session safe:
child.onExit(({ exitCode, signal }) => {
  this.state = SessionState.TERMINATED;
  // emit event or callback, do NOT exit process
});
```

### Pattern 4: SessionManager with Reaper

**What:** Central manager maintaining `Map<string, Session>`, with a periodic reaper timer for orphan detection and graceful shutdown on process exit.

**When to use:** All session CRUD operations.

**Example:**
```typescript
// session-manager.ts
import { nanoid } from "nanoid";
import { SessionState } from "@cc-anywhere/shared";

export class SessionManager {
  private sessions = new Map<string, Session>();
  private reaperTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;

  start(): void {
    this.reaperTimer = setInterval(() => this.reap(), 30_000);
    this.reaperTimer.unref(); // 不阻止进程退出
    const shutdown = () => void this.shutdown();
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    process.once("beforeExit", shutdown);
  }

  async createSession(mode: SessionMode, options?: SessionCreateOptions): Promise<Session> {
    const id = nanoid();
    const session = mode === "pty"
      ? new PtySession(id, options)
      : new SdkSession(id, options);
    this.sessions.set(id, session);
    return session;
  }

  listSessions(): SessionInfo[] {
    return [...this.sessions.values()].map(toSessionInfo);
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  async terminateSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not found`);
    await session.terminate();
    this.sessions.delete(id);
  }

  async terminateAll(): Promise<void> {
    await Promise.allSettled(
      [...this.sessions.values()].map((s) => s.terminate())
    );
    this.sessions.clear();
  }

  private reap(): void {
    for (const [id, session] of this.sessions) {
      if (session.state === SessionState.TERMINATED) {
        this.sessions.delete(id);
        continue;
      }
      if (!session.isAlive()) {
        session.state = SessionState.TERMINATED;
        this.sessions.delete(id);
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
    await this.terminateAll();
  }
}
```

### Pattern 5: Process Liveness Check

**What:** Use `process.kill(pid, 0)` to check if a process is still running without actually sending a signal.

**When to use:** Reaper timer on every 30-second tick, and in `Session.isAlive()`.

```typescript
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
```

### Pattern 6: Graceful Termination with Escalation

**What:** Send SIGTERM, wait grace period, SIGKILL survivors.

**When to use:** `Session.terminate()` and `SessionManager.terminateAll()`.

```typescript
async function terminateProcess(pid: number, graceMs = 5000): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // 进程已退出
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (!isProcessAlive(pid)) return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 在等待期间退出
  }
}
```

### Anti-Patterns to Avoid

- **Sharing a claude child process between PTY and SDK modes:** The Agent SDK spawns its own process internally. PTY sessions use node-pty's spawn. They are architecturally separate processes (D-01).
- **Exposing CLI subcommands or HTTP endpoints in Phase 3:** D-07 explicitly restricts to TypeScript API only. Phase 4 relay code will consume SessionManager programmatically.
- **Using `process.exit()` inside session lifecycle handlers:** Fatal in multi-session context. Only the top-level entry point should call `process.exit()`.
- **Modifying PtyManager's tested behavior:** PtyManager has 102 passing tests from Phase 2. Do not modify it for multi-session support. Create a new PtySession class instead.
- **Blocking the event loop with for-await on SDK message stream:** Each SDK session's message consumption must run in its own async context without blocking other operations.

## Common Pitfalls

### Pitfall 1: PtyManager calls process.exit() on child exit
**What goes wrong:** The existing PtyManager (line 77-87) calls `process.exit()` when the claude child process exits. In multi-session mode, this kills the entire proxy when any single PTY session ends.
**Why it happens:** Phase 2 designed PtyManager for single-session mode where proxy lifecycle is 1:1 with the claude process.
**How to avoid:** Create a new PtySession class that wraps node-pty directly but emits events on child exit instead of calling process.exit(). Keep PtyManager unchanged for the single-session CLI code path.
**Warning signs:** Starting a second PTY session causes the proxy to exit when the first session ends.

### Pitfall 2: Agent SDK query() for-await blocks other sessions
**What goes wrong:** The `for await (const message of q)` loop is infinite until the session ends. If run synchronously in createSession(), it blocks all subsequent SessionManager operations.
**Why it happens:** AsyncGenerator iteration is blocking within its async context. If there's only one execution context, everything else waits.
**How to avoid:** Start the message consumption loop as a detached async operation (fire-and-forget with error handling). The SdkSession constructor starts `query()` and kicks off message processing, but returns immediately. Use callbacks/events for message delivery to external consumers.
**Warning signs:** Second createSession() call hangs indefinitely.

### Pitfall 3: SDK session PID not immediately available
**What goes wrong:** The Agent SDK's `query()` spawns a claude child process internally. The PID is not returned as a direct property on the Query object. The session_id in SDKMessage is the SDK's internal session UUID, not a process ID.
**Why it happens:** The SDK abstracts away process management. The PID of the underlying claude process is not directly exposed in the SDK API.
**How to avoid:** For process liveness checking, we have two approaches: (a) use `Query.close()` as the primary termination mechanism and track session liveness via the SDK's own message stream (if the stream ends, the session is dead), or (b) inspect child processes spawned around the time of `query()` call. Approach (a) is recommended -- track liveness by whether the async generator has completed rather than by PID.
**Warning signs:** `session.pid` is undefined for SDK sessions; reaper cannot detect orphaned SDK processes by PID.

### Pitfall 4: Reaper races with API operations
**What goes wrong:** The reaper timer fires while someone is in the middle of a session operation (e.g., between getSession() and subsequent method calls). The session gets deleted while in use.
**Why it happens:** The reaper runs on a setInterval, creating a race window with API callers.
**How to avoid:** Reaper should only update state to TERMINATED and delete from map. API callers should always check `session.state` before performing operations. SessionManager methods should handle "session already terminated" gracefully.
**Warning signs:** Intermittent "session not found" errors; operations fail on sessions that were just retrieved.

### Pitfall 5: Leaked stdin listeners from PtySession
**What goes wrong:** If multiple PTY sessions attach stdin listeners and one session ends without cleaning up, the listener remains and corrupts input to other sessions.
**Why it happens:** PtyManager attaches `stdin.on("data", ...)` directly. In multi-session mode, multiple sessions would fight over the same stdin.
**How to avoid:** In Phase 3, PTY sessions created via SessionManager do NOT attach to process.stdin/stdout. They are headless PTY processes. Only the single-session CLI entry path (PtyManager in index.ts) attaches to the real terminal. SessionManager's PTY sessions write/read via their own IPty interface, not the process stdin/stdout.
**Warning signs:** Input typed in terminal appears in wrong session; garbled output.

### Pitfall 6: reaperTimer.unref() forgotten
**What goes wrong:** The 30-second setInterval keeps the Node.js event loop alive, preventing clean process exit even when all sessions are terminated and the program should exit.
**Why it happens:** setInterval registers a timer ref that keeps the process running.
**How to avoid:** Call `this.reaperTimer.unref()` after creating the interval, and `clearInterval()` in shutdown().
**Warning signs:** Proxy process hangs after all sessions end.

## Code Examples

### Agent SDK query() with streaming input and canUseTool

Verified from official Agent SDK TypeScript Reference (platform.claude.com).

```typescript
// Source: https://platform.claude.com/docs/en/agent-sdk/typescript
// Source: https://platform.claude.com/docs/en/agent-sdk/user-input

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

// Streaming input mode: pass AsyncGenerator as prompt
async function* messageStream(): AsyncGenerator<SDKUserMessage> {
  yield {
    type: "user",
    message: {
      role: "user",
      content: "Explain the authentication flow"
    }
  };
}

const q = query({
  prompt: messageStream(),
  options: {
    includePartialMessages: true,
    cwd: "/path/to/project",
    canUseTool: async (toolName, input, opts) => {
      // opts.toolUseID -- 该次工具调用的唯一标识
      // opts.signal -- AbortSignal，用于取消
      // opts.decisionReason -- 为什么需要权限确认
      return { behavior: "deny", message: "Denied by policy" };
    },
  },
});

// 消费消息流
for await (const message of q) {
  switch (message.type) {
    case "system":
      // 初始化消息，包含 session_id, tools, model 等
      break;
    case "assistant":
      // 完整的助手回复消息
      break;
    case "stream_event":
      // 增量流式事件（需 includePartialMessages: true）
      if (message.event.type === "content_block_delta"
          && message.event.delta.type === "text_delta") {
        process.stdout.write(message.event.delta.text);
      }
      break;
    case "result":
      // 最终结果：message.result, message.total_cost_usd, message.usage
      break;
  }
}

// 终止会话
q.close();
```

### SDKMessage type union (key types for Phase 3)

```typescript
// Source: https://platform.claude.com/docs/en/agent-sdk/typescript#sdk-message

type SDKMessage =
  | SDKAssistantMessage     // type: "assistant" -- 完整助手回复
  | SDKUserMessage          // type: "user" -- 用户消息
  | SDKResultMessage        // type: "result" -- 最终结果
  | SDKSystemMessage        // type: "system" -- 初始化消息
  | SDKPartialAssistantMessage  // type: "stream_event" -- 流式增量事件
  | SDKStatusMessage        // type: "status" -- 状态变更
  | SDKToolProgressMessage  // type: "tool_progress" -- 工具执行进度
  // ... plus ~10 other specialized types

// SDKResultMessage 包含 subtype 区分成功和各种错误
type SDKResultMessage =
  | { type: "result"; subtype: "success"; result: string; total_cost_usd: number; usage: ... }
  | { type: "result"; subtype: "error_max_turns" | "error_during_execution" | ...; errors: string[] }
```

### Session state transition mapping

```typescript
// Source: packages/shared/src/constants/session.ts

// SDK 消息类型 -> SessionState 映射关系
// SDKSystemMessage (init) -> SessionState.IDLE
// SDKUserMessage (user input injected) -> SessionState.WORKING
// canUseTool callback triggered -> SessionState.WAITING_APPROVAL
// canUseTool callback returns -> SessionState.WORKING
// SDKResultMessage (success) -> SessionState.IDLE
// SDKResultMessage (error_*) -> SessionState.ERROR
// query.close() called -> SessionState.TERMINATED
// child process dies unexpectedly -> SessionState.TERMINATED
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `@anthropic-ai/claude-code` | `@anthropic-ai/claude-agent-sdk` | 2025 | Package renamed. Import paths changed. |
| V1 API only | V2 preview available | 2026 | V2 adds `send()` and `stream()` patterns. V1 still supported. Phase 3 uses V1 (stable). |
| Single prompt string | Streaming input `AsyncGenerator<SDKUserMessage>` | v0.2.x | Streaming input is now recommended for all interactive use cases. |
| `query.abort()` | `query.close()` | v0.2.x | `close()` terminates underlying process. `abort()` deprecated. |

**Deprecated/outdated:**
- Package name `@anthropic-ai/claude-code`: renamed to `@anthropic-ai/claude-agent-sdk`
- `maxThinkingTokens` option: use `thinking` option instead
- Single-message input mode for interactive sessions: streaming input mode is recommended

## Open Questions

1. **SDK session PID accessibility**
   - What we know: The SDK spawns a child claude process internally. `Query.close()` terminates it. The PID is not directly exposed on the Query object.
   - What's unclear: How to get the PID for process liveness checking in the reaper. The `SDKSystemMessage` has `session_id` (UUID) but not a PID.
   - Recommendation: Track session liveness by whether the async generator has completed (stream ended = session dead), not by PID. For SDK sessions, `isAlive()` checks if the message stream is still active. `Query.close()` is the primary termination mechanism. The reaper detects "stream ended but session not cleaned up" states.

2. **SDK session error recovery**
   - What we know: `SDKResultMessage` has error subtypes: `error_max_turns`, `error_during_execution`, `error_max_budget_usd`.
   - What's unclear: Whether a failed SDK session can be resumed via the `resume` option, or if a new `query()` call is needed.
   - Recommendation: For Phase 3, mark errored sessions as `SessionState.ERROR` and let the consumer decide whether to terminate and create a new session. No automatic retry.

3. **Streaming incompatibility with extended thinking**
   - What we know: When `maxThinkingTokens` is explicitly set, `StreamEvent` messages are not emitted. Only complete messages arrive.
   - What's unclear: Whether the default `thinking: { type: 'adaptive' }` triggers this limitation.
   - Recommendation: Don't set `maxThinkingTokens` explicitly. Use the default adaptive thinking. If streaming events stop, this is a likely cause.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | Yes | v22.16.0 | -- |
| Claude CLI | Agent SDK | Yes | 2.1.91 | -- |
| pnpm | Package manager | Yes | (installed) | -- |

**Missing dependencies:** None. All required tools are available.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^2.x |
| Config file | `apps/proxy/vitest.config.ts` (per-package) + `vitest.config.ts` (workspace root) |
| Quick run command | `pnpm vitest run --project proxy` |
| Full suite command | `pnpm vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PROXY-02a | SDK session creates and streams messages | unit (mocked SDK) | `pnpm vitest run --project proxy -- sdk-session` | Wave 0 |
| PROXY-02b | PTY session and SDK session coexist without interference | unit | `pnpm vitest run --project proxy -- session-manager` | Wave 0 |
| PROXY-02c | canUseTool callback denies all by default | unit (mocked SDK) | `pnpm vitest run --project proxy -- sdk-session` | Wave 0 |
| PROXY-03a | createSession creates sessions with unique IDs | unit | `pnpm vitest run --project proxy -- session-manager` | Wave 0 |
| PROXY-03b | listSessions returns all active sessions | unit | `pnpm vitest run --project proxy -- session-manager` | Wave 0 |
| PROXY-03c | getSession returns correct session or undefined | unit | `pnpm vitest run --project proxy -- session-manager` | Wave 0 |
| PROXY-03d | terminateSession terminates and removes session | unit | `pnpm vitest run --project proxy -- session-manager` | Wave 0 |
| PROXY-03e | terminateAll terminates all sessions | unit | `pnpm vitest run --project proxy -- session-manager` | Wave 0 |
| PROXY-03f | Session reports correct state (idle/working/waiting_approval/error/terminated) | unit | `pnpm vitest run --project proxy -- session-manager` | Wave 0 |
| PROXY-03g | Reaper detects dead processes and marks terminated | unit (mocked process.kill) | `pnpm vitest run --project proxy -- session-manager` | Wave 0 |
| PROXY-03h | Shutdown sends SIGTERM then SIGKILL to all children | unit | `pnpm vitest run --project proxy -- session-manager` | Wave 0 |
| PROXY-03i | PtySession does not call process.exit() on child exit | unit | `pnpm vitest run --project proxy -- pty-session` | Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm vitest run --project proxy`
- **Per wave merge:** `pnpm vitest run` (full workspace)
- **Phase gate:** Full suite green before verification

### Wave 0 Gaps
- [ ] `apps/proxy/src/__tests__/session-manager.test.ts` -- covers PROXY-03a through PROXY-03h
- [ ] `apps/proxy/src/__tests__/sdk-session.test.ts` -- covers PROXY-02a, PROXY-02c
- [ ] `apps/proxy/src/__tests__/pty-session.test.ts` -- covers PROXY-03i

## Sources

### Primary (HIGH confidence)
- [Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) -- query(), Query object, Options, SDKMessage types, CanUseTool, close(), streaming input
- [Agent SDK Streaming Output](https://platform.claude.com/docs/en/agent-sdk/streaming-output) -- SDKPartialAssistantMessage, StreamEvent, message flow, known limitations
- [Agent SDK User Input](https://platform.claude.com/docs/en/agent-sdk/user-input) -- canUseTool callback, PermissionResult (allow/deny), toolUseID, complete handler pattern
- [Agent SDK Streaming vs Single Mode](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) -- AsyncGenerator streaming input, multi-turn conversations, recommended over single-message
- [Node.js process.kill() docs](https://nodejs.org/api/process.html#processkillpid-signal) -- kill(pid, 0) liveness check
- npm registry: `@anthropic-ai/claude-agent-sdk` v0.2.91, `nanoid` v5.1.7 -- version verification

### Secondary (MEDIUM confidence)
- `.planning/research/PITFALLS.md` -- Orphaned processes (Pitfall 3), Agent SDK instability (Pitfall 6)
- `.planning/research/ARCHITECTURE.md` -- Dual-mode architecture, message flow patterns
- `.planning/research/SUMMARY.md` -- Overall project research summary

### Tertiary (LOW confidence)
- None for this phase. All critical claims verified against official documentation.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- Agent SDK v0.2.91 verified on npm, all APIs confirmed in official docs
- Architecture: HIGH -- SessionManager pattern is straightforward Map + timer, SDK API is well-documented
- Pitfalls: HIGH -- PtyManager process.exit() issue verified by reading source code, SDK message loop blocking verified from API structure

**Research date:** 2026-04-03
**Valid until:** 2026-04-17 (Agent SDK v0.2.x may release updates; check changelog before implementation)
