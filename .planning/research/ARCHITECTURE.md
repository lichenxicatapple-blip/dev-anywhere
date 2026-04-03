# Architecture Research

**Domain:** CLI proxy + relay server + mobile client (remote IDE control)
**Researched:** 2026-04-03
**Confidence:** HIGH

## System Overview

```
+-------------------+         +-------------------+         +-------------------+
|   User's Machine  |         |   Public Server   |         |   User's Phone    |
|                   |         |                   |         |                   |
|  +-------------+  |         |  +-------------+  |         |  +-------------+  |
|  | Claude Code |  |         |  |   Relay     |  |         |  | Feishu Mini |  |
|  |   CLI       |  |         |  |   Server    |  |         |  |  Program    |  |
|  +------+------+  |         |  +------+------+  |         |  +------+------+  |
|         |         |         |         |         |         |         |         |
|         | SDK     |         |         |         |         |         |         |
|         | IPC     |         |         |         |         |         |         |
|         v         |         |         |         |         |         |         |
|  +------+------+  |  WSS   |  +------+------+  |  HTTPS  |  +------+------+  |
|  | Local Proxy |--+--------+->| WS Gateway  |<-+--------+-| WS Client   |  |
|  |             |<-+--------+--| + REST API  |--+--------+->|             |  |
|  +------+------+  |         |  +------+------+  |         |  +------+------+  |
|         |         |         |         |         |         |         |         |
|  +------+------+  |         |  +------+------+  |         |                   |
|  | Terminal    |  |         |  | Session     |  |         |                   |
|  | Passthrough |  |         |  | Store       |  |         |                   |
|  +-------------+  |         |  +-------------+  |         |                   |
+-------------------+         +-------------------+         +-------------------+
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| **Local Proxy** | Spawn Claude Code via Agent SDK, intercept all SDK messages, forward to relay, pass terminal output to local TTY | TypeScript process using `@anthropic-ai/claude-agent-sdk` `query()` with streaming input mode |
| **Terminal Passthrough** | Ensure local terminal experience is identical to native Claude Code | Pipe SDK stream events to stdout, read stdin for local user input |
| **Relay Server** | Route messages between local proxies and Feishu clients, manage session registry, buffer messages for offline clients | Node.js HTTP + WebSocket server (e.g. Fastify + ws) |
| **WS Gateway** | Accept WebSocket connections from local proxies and Feishu clients, authenticate, multiplex sessions | Part of relay server, handles connection lifecycle |
| **Session Store** | Persist session metadata and message history for reconnection | SQLite or file-based JSONL per session |
| **Feishu Mini Program** | Chat UI, session list, output streaming display, tool approval dialog | Feishu mini program framework (tt.* APIs) with WebSocket |

## Key Architectural Decision: Agent SDK vs PTY/CLI Spawn

**Recommendation: Use the Claude Code Agent SDK (TypeScript).**

The Agent SDK (`@anthropic-ai/claude-agent-sdk`) provides:

1. **Structured message stream** -- `SDKMessage` union type with typed events (`assistant`, `stream_event`, `result`, `system`, etc.) instead of raw terminal bytes
2. **Built-in tool approval callback** -- `canUseTool` callback pauses execution until you return allow/deny, which maps directly to remote approval via Feishu
3. **Streaming input mode** -- `AsyncGenerator<SDKUserMessage>` allows sending follow-up messages from Feishu into a live session
4. **Session management** -- `listSessions()`, `getSessionMessages()`, `resume` option for reconnection
5. **Permission control** -- `permissionMode`, `allowedTools`, `disallowedTools` for fine-grained control

**Why not PTY spawn:** The Agent SDK was specifically designed for programmatic control. PTY spawning (`node-pty`) gives raw terminal bytes that need complex ANSI parsing. The SDK gives structured JSON messages. There is a known issue where Claude Code hangs when spawned via `child_process.spawn()` in Node.js -- the SDK works around this internally.

**Trade-off:** The Agent SDK's streaming mode does not produce native terminal rendering (colors, cursor movement, progress bars). The local terminal experience will be "SDK-rendered" rather than native Claude Code TTY output. This is acceptable because:
- The SDK provides all semantic content (text, tool calls, thinking, results)
- A local renderer can reconstruct a good terminal experience from structured events
- The alternative (PTY + ANSI parsing) is fragile and loses semantic information needed for remote display

**Confidence: HIGH** -- Based on official Agent SDK documentation at platform.claude.com.

## Recommended Project Structure

```
cc-anywhere/
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── packages/
│   ├── shared/                 # 三个组件共享的类型和协议定义
│   │   ├── src/
│   │   │   ├── protocol.ts     # WebSocket 消息协议类型
│   │   │   ├── types.ts        # 会话、用户等共享类型
│   │   │   └── constants.ts    # 协议版本号、事件名等常量
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── proxy/                  # 本地 CLI 代理
│   │   ├── src/
│   │   │   ├── cli.ts          # CLI 入口，解析参数
│   │   │   ├── agent.ts        # Agent SDK 封装，管理 Claude Code 进程
│   │   │   ├── bridge.ts       # WebSocket 客户端，连接 relay
│   │   │   ├── terminal.ts     # 本地终端渲染器
│   │   │   ├── session.ts      # 本地会话状态管理
│   │   │   └── approval.ts     # 工具审批路由（本地 or 远程）
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── relay/                  # 中转服务器
│   │   ├── src/
│   │   │   ├── server.ts       # HTTP + WebSocket 服务入口
│   │   │   ├── gateway.ts      # WebSocket 连接管理和认证
│   │   │   ├── router.ts       # 消息路由，proxy <-> mini program
│   │   │   ├── session.ts      # 会话注册表和状态
│   │   │   ├── store.ts        # 消息持久化
│   │   │   └── auth.ts         # Token 验证（简单 pre-shared key）
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── miniprogram/            # 飞书小程序
│       ├── src/
│       │   ├── app.ts          # 小程序入口
│       │   ├── pages/
│       │   │   ├── sessions/   # 会话列表页
│       │   │   ├── chat/       # 聊天交互页
│       │   │   └── approval/   # 工具审批页
│       │   ├── services/
│       │   │   ├── ws.ts       # WebSocket 连接管理
│       │   │   └── api.ts      # REST API 调用
│       │   └── utils/
│       │       └── renderer.ts # 消息渲染（Markdown, code blocks）
│       ├── project.config.json
│       └── tsconfig.json
└── package.json
```

### Structure Rationale

- **packages/shared/:** 协议类型定义是三个组件的契约，放在共享包里确保类型一致。pnpm workspace 让其他包直接引用 `@cc-anywhere/shared`。
- **packages/proxy/:** 本地代理是一个独立的 CLI 工具，通过 npm 全局安装或 npx 运行。它同时面向两个"用户"：本地终端和远程 relay。
- **packages/relay/:** 中转服务器是无状态的消息路由器（会话状态持久化到磁盘），可以部署在任何有公网 IP 的服务器上。
- **packages/miniprogram/:** 飞书小程序有自己的构建体系和运行时约束，但通过 shared 包共享协议类型。注意：飞书小程序不能直接使用 npm 包，需要构建时将 shared 的类型内联。

## Architectural Patterns

### Pattern 1: Agent SDK Streaming Input for Bidirectional Control

**What:** 使用 Agent SDK 的 streaming input mode (`AsyncGenerator<SDKUserMessage>`) 作为与 Claude Code 进程交互的核心机制。来自本地终端或飞书的用户输入都通过同一个 generator yield 到 SDK。

**When to use:** 所有会话交互场景。这是唯一支持多轮对话、中断、工具审批的 SDK 模式。

**Trade-offs:**
- Pro: 原生支持多轮对话，不需要自己管理会话状态
- Pro: `canUseTool` 回调天然支持异步审批（可以等待远程 Feishu 用户的响应）
- Con: 需要自己管理 AsyncGenerator 的生命周期，处理背压

**Example:**
```typescript
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

// 创建一个可以从外部 push 消息的 generator
function createMessageChannel() {
  const pending: SDKUserMessage[] = [];
  let resolve: (() => void) | null = null;

  async function* generator(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      if (pending.length === 0) {
        await new Promise<void>(r => { resolve = r; });
      }
      while (pending.length > 0) {
        yield pending.shift()!;
      }
    }
  }

  function send(msg: SDKUserMessage) {
    pending.push(msg);
    resolve?.();
  }

  return { generator: generator(), send };
}

const channel = createMessageChannel();

// 来自本地终端或飞书的消息都通过 channel.send() 注入
const q = query({
  prompt: channel.generator,
  options: {
    includePartialMessages: true,
    canUseTool: async (toolName, input, opts) => {
      // 将审批请求转发到 relay -> Feishu
      // 等待用户响应
      const decision = await forwardApprovalToRelay(toolName, input);
      return decision;
    },
  },
});

for await (const message of q) {
  // 同时推送到本地终端和 relay
  renderToTerminal(message);
  forwardToRelay(message);
}
```

### Pattern 2: Message Envelope Protocol

**What:** 所有 WebSocket 通信使用统一的消息信封格式，包含路由信息、消息类型、payload。不使用 JSON-RPC，使用更简单的自定义协议。

**When to use:** proxy <-> relay <-> miniprogram 之间的所有通信。

**Trade-offs:**
- Pro: 比 JSON-RPC 更轻量，不需要请求-响应配对
- Pro: 支持单向推送（流式输出）和请求-响应（工具审批）
- Con: 需要自己实现消息关联（用 requestId）

**Example:**
```typescript
// packages/shared/src/protocol.ts

interface MessageEnvelope {
  // 消息唯一 ID
  id: string;
  // 关联的会话 ID
  sessionId: string;
  // 消息类型，决定 payload 的结构
  type: MessageType;
  // 消息负载
  payload: unknown;
  // 时间戳
  ts: number;
  // 如果是响应，关联的请求 ID
  replyTo?: string;
}

type MessageType =
  // Proxy -> Relay -> Mini Program
  | "session.created"
  | "session.ended"
  | "output.text"           // 文本增量输出
  | "output.tool_start"     // 工具调用开始
  | "output.tool_end"       // 工具调用结束
  | "output.result"         // 最终结果
  | "approval.request"      // 工具审批请求
  // Mini Program -> Relay -> Proxy
  | "input.message"         // 用户发送消息
  | "approval.response"     // 工具审批响应
  | "session.create"        // 请求创建新会话
  | "session.terminate"     // 请求终止会话
  // Relay -> Proxy / Mini Program
  | "error"                 // 错误通知
  | "sync.sessions"         // 会话列表同步
  | "sync.history";         // 历史消息同步
```

### Pattern 3: Dual-Source Input Arbitration

**What:** 本地终端和飞书小程序可以同时向同一个 Claude Code 会话发送输入。需要一个仲裁机制防止冲突。

**When to use:** 当用户同时在电脑和手机上操作同一个会话时。

**Trade-offs:**
- Pro: 灵活，不限制用户的使用方式
- Con: 需要处理竞态条件
- 简单方案: 先到先得，后到的排队

**规则:**
1. Claude Code 同一时间只能处理一个用户消息（SDK 限制）
2. 如果 Claude 正在处理中，新消息进入队列
3. 两端都能看到当前处理状态和队列中的消息
4. 工具审批请求同时发送到两端，第一个响应生效

## Data Flow

### Core Message Flow

```
[Local Terminal]                [Local Proxy]                [Relay Server]               [Feishu Mini Program]
      |                              |                              |                              |
      |-- user input (stdin) ------->|                              |                              |
      |                              |-- input.message ------------>|-- input.message ------------>|
      |                              |                              |                              |
      |                              |== yield to SDK generator ===>|                              |
      |                              |                              |                              |
      |<- stream text (stdout) -----|<- SDKMessage (stream_event) -|                              |
      |                              |-- output.text -------------->|-- output.text -------------->|
      |                              |                              |                              |
      |                              |<- SDKMessage (tool_use) -----|                              |
      |<- tool approval prompt ------|-- approval.request --------->|-- approval.request --------->|
      |                              |                              |                              |
      |                              |                              |<- approval.response ---------|
      |                              |<- approval.response ---------|                              |
      |                              |== canUseTool returns =======>|                              |
      |                              |                              |                              |
```

### Feishu-Initiated Message Flow

```
[Feishu Mini Program]            [Relay Server]               [Local Proxy]               [Claude Code SDK]
      |                              |                              |                              |
      |-- input.message ------------>|                              |                              |
      |                              |-- input.message ------------>|                              |
      |                              |                              |-- yield to generator -------->|
      |                              |                              |                              |
      |                              |                              |<- SDKMessage (stream) -------|
      |<- output.text ---------------|<- output.text ---------------|                              |
      |                              |                              |                              |
```

### Session Lifecycle

```
[Session Creation]
  1. Proxy starts -> connects to relay via WebSocket
  2. Proxy registers with relay: { proxyId, availableSessions: [] }
  3. User (local or Feishu) requests new session
  4. Proxy spawns Claude Code via Agent SDK query()
  5. Proxy notifies relay: session.created { sessionId, cwd, model }
  6. Relay broadcasts to connected Feishu clients

[Session Reconnection]
  1. Proxy reconnects to relay after disconnect
  2. Relay replays buffered messages since disconnect
  3. If Claude Code process died, proxy can resume via SDK's `resume` option
  4. Feishu client reconnects -> relay sends current session list + recent history

[Session Termination]
  1. User requests terminate (local or Feishu)
  2. Proxy calls query.close() on the SDK
  3. Proxy notifies relay: session.ended { sessionId, reason }
  4. Relay notifies all connected Feishu clients
```

### Tool Approval Flow (Critical Path)

```
[Claude Code SDK]                [Local Proxy]                [Relay Server]               [Feishu Mini Program]
      |                              |                              |                              |
      |-- canUseTool callback ------>|                              |                              |
      |   (execution paused)         |                              |                              |
      |                              |-- approval.request --------->|-- approval.request --------->|
      |                              |   { requestId, toolName,     |   (push notification)        |
      |                              |     input, decisionReason }  |                              |
      |                              |                              |                              |
      |                              |   === WAITING ===            |   === USER DECIDES ===       |
      |                              |                              |                              |
      |                              |                              |<- approval.response ---------|
      |                              |<- approval.response ---------|   { requestId,               |
      |                              |   { requestId,               |     behavior: allow/deny,    |
      |                              |     behavior, message? }     |     message? }               |
      |                              |                              |                              |
      |<- PermissionResult ----------|                              |                              |
      |   (execution resumes)        |                              |                              |
```

**Timeout handling:** If no approval response within configurable timeout (default 5 minutes), deny the tool call. The proxy can also approve locally if the user is at the terminal.

### Key Data Flows

1. **Output streaming:** SDK `stream_event` messages are transformed into `output.text` / `output.tool_start` / `output.tool_end` envelopes, forwarded to relay, then to Feishu. Each delta is a separate message for real-time display.
2. **Input routing:** Messages from both local stdin and Feishu are funneled into a single `AsyncGenerator` that feeds the SDK. The proxy serializes these to prevent race conditions.
3. **Approval bridging:** The SDK's `canUseTool` callback creates a Promise that resolves when the relay delivers an `approval.response`. The callback blocks SDK execution until resolved.
4. **Session sync:** On Feishu client connect, the relay pushes the full session list and recent message history (last N messages or since timestamp) so the UI can render immediately.

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 1 user, 1 machine | Single relay instance, SQLite storage, everything works as-is |
| 1 user, multiple machines | Relay identifies proxies by proxyId, routes to correct proxy. No changes needed. |
| 5-10 users (team) | Add pre-shared key auth per user. Relay needs minimal resources -- it's just routing messages. |
| 50+ users | Consider Redis pub/sub for relay horizontal scaling, PostgreSQL for session store. But this is likely out of scope for v1. |

### Scaling Priorities

1. **First bottleneck:** WebSocket connection management on relay. A single Node.js process can handle thousands of concurrent WebSocket connections, so this is unlikely to be an issue for the target audience (individual developers / small teams).
2. **Second bottleneck:** Message history storage. SQLite handles this fine for single-digit users. For growth, move to PostgreSQL.

## Anti-Patterns

### Anti-Pattern 1: Parsing Raw Terminal Output

**What people do:** Spawn Claude Code as a PTY process, capture raw ANSI terminal output, try to parse it into structured data for the mobile UI.
**Why it's wrong:** ANSI escape sequences are complex and context-dependent. Terminal state (cursor position, scroll region, colors) is hard to track. You lose semantic information (is this text output or a tool call prompt?). The Claude Code UI may change rendering at any time.
**Do this instead:** Use the Agent SDK which provides structured `SDKMessage` objects with typed content blocks.

### Anti-Pattern 2: Relay Server as State Owner

**What people do:** Store all session state in the relay server, make the relay responsible for managing Claude Code sessions.
**Why it's wrong:** The relay becomes a single point of failure. If it restarts, all sessions are lost. It also means the relay needs to understand Claude Code semantics, coupling it tightly.
**Do this instead:** The proxy owns session state. The relay is a dumb message router that buffers recent messages for reconnection. The proxy can reconstruct its state from the SDK's session persistence.

### Anti-Pattern 3: Synchronous Approval with No Timeout

**What people do:** Wait indefinitely for tool approval from the remote user.
**Why it's wrong:** The Claude Code process is blocked. If the user's phone is off or they walked away, the session is stuck forever. Local terminal user also can't proceed.
**Do this instead:** Implement configurable timeouts. Allow local terminal to also respond to approval requests. Default to deny on timeout.

### Anti-Pattern 4: Forwarding Raw SDK Messages

**What people do:** Forward the full `SDKMessage` objects directly to the Feishu client.
**Why it's wrong:** SDK messages contain internal fields, Anthropic API structures (`BetaMessage`), and large payloads (full code file contents in tool results). The Feishu mini program doesn't need most of this. WebSocket message size is constrained (especially on mobile).
**Do this instead:** Transform SDK messages into compact protocol messages (`output.text`, `output.tool_start`, etc.) at the proxy level. Only send what the mobile UI needs to render.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Claude Code CLI | Agent SDK `query()` with streaming input | Must be installed on user's machine. SDK spawns the process internally. |
| Feishu Open Platform | Mini program tt.* APIs + WebSocket | Mini program can only have 1-2 concurrent WebSocket connections. Use a single multiplexed connection. |
| Feishu Notifications | tt.showToast / tt.vibrate for approval alerts | No push notifications from mini program -- user must have the mini program open. Consider Feishu bot message as notification channel. |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Proxy <-> SDK | In-process TypeScript API (`query()` async generator) | Same Node.js process. No serialization needed. |
| Proxy <-> Relay | WebSocket (WSS) with MessageEnvelope protocol | Proxy initiates connection (outbound). Heartbeat every 30s. Auto-reconnect with exponential backoff. |
| Relay <-> Mini Program | WebSocket (WSS) with MessageEnvelope protocol | Mini program initiates connection. Same protocol as proxy connection but different message subset. |
| Relay REST API | HTTPS for session list, history query | Mini program uses for initial data load and offline history. Not for real-time. |

## Build Order (Dependencies)

The components have clear dependency ordering:

1. **Phase 1: shared + proxy (core)** -- The proxy is the foundation. It wraps Claude Code via SDK, manages sessions locally, and renders to terminal. At this point it works as a standalone enhanced Claude Code wrapper (no remote features). shared package defines the protocol types consumed by all other packages.

2. **Phase 2: relay server** -- The relay depends on the shared protocol types. It receives connections from proxies and routes messages. Can be tested with a mock proxy client.

3. **Phase 3: proxy <-> relay integration** -- Connect the proxy to the relay. The proxy now forwards output and approval requests. Can be tested with WebSocket inspection tools.

4. **Phase 4: Feishu mini program** -- The mini program depends on the relay being functional. It connects to relay, displays sessions, renders output, and handles approvals.

**Rationale:** Each phase produces a testable, useful artifact. Phase 1 alone is useful (improved Claude Code wrapper). Phase 2+3 enable monitoring. Phase 4 completes the remote control story.

## Sources

- [Claude Code Agent SDK - TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) -- HIGH confidence
- [Agent SDK Streaming Output](https://platform.claude.com/docs/en/agent-sdk/streaming-output) -- HIGH confidence
- [Agent SDK Streaming vs Single Mode](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) -- HIGH confidence
- [Agent SDK Permissions](https://platform.claude.com/docs/en/agent-sdk/permissions) -- HIGH confidence
- [Agent SDK User Input / canUseTool](https://platform.claude.com/docs/en/agent-sdk/user-input) -- HIGH confidence
- [Claude Code Headless / Programmatic Usage](https://code.claude.com/docs/en/headless) -- HIGH confidence
- [feishu-cursor-claw (prior art)](https://github.com/nongjun/feishu-cursor-claw) -- MEDIUM confidence (similar but different target)
- [Feishu Open Platform Documentation](https://open.feishu.cn/document/home/index) -- MEDIUM confidence (general, not mini program WebSocket specific)
- [WebSocket Relay Patterns](https://ably.com/topic/websocket-architecture-best-practices) -- MEDIUM confidence
- [pnpm Workspaces](https://pnpm.io/workspaces) -- HIGH confidence

---
*Architecture research for: CC Anywhere (Claude Code remote control via Feishu)*
*Researched: 2026-04-03*
