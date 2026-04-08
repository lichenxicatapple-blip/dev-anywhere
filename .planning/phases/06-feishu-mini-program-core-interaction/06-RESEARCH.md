# Phase 6: Feishu Mini Program - Core Interaction - Research

**Researched:** 2026-04-08
**Domain:** Taro React mini program + WebSocket real-time communication + PTY terminal rendering + Claude Code stream-json protocol
**Confidence:** HIGH

## Summary

Phase 6 is the largest phase in the project -- it builds the complete Feishu mini program from spike prototypes into a working product. The phase covers three pages (proxy select, session list, chat), two rendering modes (PTY terminal grid + JSON chat bubbles), real-time WebSocket communication with the relay server, tool approval workflow, slash/file pickers, session resume, and PTY semantic signal extraction.

The spike prototypes (`spike-render`, `spike-chat-json`, `spike-chat-pty`, `spike-session-list`, `spike-picker`, `spike-bubble-anim`, `spike-typewriter`) have already validated all critical rendering patterns on Feishu real devices. The UI-SPEC (06-UI-SPEC.md) is approved. The shared schema package (`@cc-anywhere/shared`) already defines 16 MessageEnvelope types and RelayControl messages. The proxy already has session worker IPC, relay connection, and tool approval infrastructure (currently auto-deny). The relay already routes messages bidirectionally between proxy and client WebSocket endpoints.

**Primary recommendation:** Structure the work in three tiers: (1) Shared schema extensions + proxy-side new features (terminal frame extraction, tool approval forwarding, command/file discovery, session resume, PTY semantic signals), (2) Mini program WebSocket transport layer + state management, (3) Three production pages built from spike code. The mini program should NOT import `@cc-anywhere/shared` at runtime (zod4 + Taro webpack5 compatibility risk); instead, define TypeScript-only type mirrors in a local `types/` directory and validate messages only on proxy/relay side.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Dual-page structure -- session list page (home) and chat page (push navigation). No TabBar.
- **D-02:** Cold start auto-navigates to last active session (sessionId persisted via `tt.setStorageSync`). No active session shows list.
- **D-03:** Session titles use auto-summary -- first 20 chars of first user message. New sessions show "New Session".
- **D-04:** Session list items show: summary title + state dot (idle/working/waiting/error with colored dots) + relative time.
- **D-05:** Create new session: "+" button in nav bar, directly creates JSON session and navigates to chat.
- **D-06:** Terminate session: left-swipe shows red "Terminate" button. PTY sessions hide terminate (D-22: only from computer). JSON sessions can terminate from phone.
- **D-07:** Session list shows both PTY and JSON sessions, distinguished by mode tag.
- **D-08:** PTY sessions use JSON structured text grid. Proxy extracts terminal canvas via `@xterm/headless` buffer API (`getLine(i).getCell(j)`) into `[{text, fg, bg, bold}]` span arrays, sent as new message type to relay then mini program.
- **D-09:** Mini program renders span arrays with `<Text selectable>` + monospace font. Preserves colors, supports long-press copy.
- **D-10:** Terminal view uses ScrollView with dual-axis scrolling (scrollX + scrollY).
- **D-11:** Adjustable font size: A-/A+ buttons for 6 tiers (8/10/12/14/16/20px), pinch-to-zoom switches tiers.
- **D-12:** Terminal view fills remaining height (flex: 1), reserves input bar space. Landscape/portrait adaptive.
- **D-13:** PTY sessions accept text input from phone (stdin write), but cannot terminate session.
- **D-14:** Left-right bubble layout: user messages right, Claude replies left. Classic IM style.
- **D-15:** Phase 6 does plain text rendering only. Code blocks, markdown, syntax highlighting deferred to Phase 8.
- **D-16:** Tool calls display as collapsible cards: header shows tool name + param summary, click to expand/collapse. Default collapsed.
- **D-17:** Streaming text appends to current bubble in real-time. Assistant delta appends, result marks completion.
- **D-18:** Auto-scroll + pause on user scroll up. "Back to bottom" button appears. Click or send to restore auto-scroll.
- **D-19:** serve.ts wraps StreamJsonEvent into assistant_message.text as JSON string -- mini program must parse this JSON to restore StreamJsonEvent and render by event type.
- **D-20:** New JSON session supports specifying working directory (cwd). Mini program shows proxy machine directory listing.
- **D-21:** New relay control messages: `dir_list_request(proxyId, path)` -> proxy lists directory; `dir_list_response(entries[])` -> returns listing.
- **D-22:** SessionCreatePayload extends `cwd` field. Proxy starts claude process in specified directory.
- **D-23:** proxy_register extends `name` field (default hostname, user-customizable).
- **D-24:** Three-level navigation: proxy select -> session list -> chat. Proxy select always shows.
- **D-25:** Tool approval in Phase 6. Three options: Allow (this time), Allow All (session-level whitelist), Deny.
- **D-26:** Tool approval card: tool name, parameter preview (JSON formatted/truncated), three action buttons.
- **D-27:** Proxy-side session-level tool whitelist: "Allow All" caches toolName, auto-approves subsequent same-name tools in session.
- **D-28:** Slash command completion with dynamic discovery from proxy (skills, commands, plugins, REPL builtins). Blacklist filtering. Push on session start + 6h refresh.
- **D-29:** @file path completion with initial two-level push, fs.watch recursive monitoring, throttled push, client-side caching. Deep directories on-demand.
- **D-30:** Reference cc-connect implementation for permission handling and session interface design.
- **D-31:** JSON session startup must use `--fork-session` to avoid interfering with local terminal.
- **D-32:** Permission responses use independent path, not blocked by "session busy" state. Relay forwards `permission_response` immediately.
- **D-33:** JSON session working state disables send button. Wait for result event. PTY unrestricted.
- **D-34:** Filter CLAUDECODE env vars before spawning claude child process.
- **D-35:** Capture Claude Code `system` event internal session ID, persist mapping (our sessionId -> Claude session ID).
- **D-36:** JSON session auto-resume with `--resume <claude-session-id> --fork-session` on process death. PTY sessions mark as "ended".
- **D-37:** Browse and resume any Claude Code history session from computer. Proxy scans `~/.claude/projects/`. New control messages `session_history_request/response`.
- **D-38:** PTY semantic signal extraction: PtyManager extracts OSC 0/OSC 9 sequences, converts to `pty_state` message type.
- **D-39:** State classification: OSC 9 "waiting for your input" -> TURN_COMPLETE; "needs your permission" -> APPROVAL_WAIT; OSC 0 spinner only -> MID_PAUSE (not forwarded).
- **D-40:** Message quoting (spike verified): long-press bubble -> "Quote" -> preview bar above input -> XML format injection.
- **D-41:** Reconnection = re-initialization. Clear caches, re-push directory tree and command list.

### Claude's Discretion
- PTY terminal frame push frequency and throttling strategy
- PTY terminal frame incremental update mechanism (full vs changed-lines-only)
- Chat page and terminal page transition animations

### Deferred Ideas (OUT OF SCOPE)
- PTY real-time output forwarding to relay (implementation is in scope, but was listed as a "deferred" item in CONTEXT.md -- note: this is actually required for Phase 6 per D-08)
- Authentication flow (pairing code + long-term token) -- before or within Phase 6
- Mini program message cache snapshot cleanup strategy -- Phase 8
- PTY xterm.js WebView rendering -- spike excluded, backup only
- Markdown / code blocks / syntax highlighting -- Phase 8
- Session naming and state tag enhancements -- Phase 10
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| FEISHU-01 | User sends text in mini program, sees Claude Code streaming response in real-time | D-17 streaming text, D-19 StreamJsonEvent parsing, WebSocket transport layer, PTY terminal frame rendering (D-08) |
| FEISHU-02 | Tool approval: mini program shows approval UI with tool name/params, user approves or denies | D-25/D-26/D-27 tool approval workflow, proxy-side whitelist, relay immediate forwarding (D-32) |
| FEISHU-03 | Session list: create, switch, terminate sessions | D-01/D-04/D-05/D-06/D-07 session management, D-24 three-level navigation, D-20/D-22 cwd selection |
| FEISHU-04 | Conversation history within session, reconnect without losing messages | D-35/D-36/D-37 session resume, Phase 5 replay protocol, D-41 reconnection re-initialization |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- Log messages in English, comments/docstrings in Chinese
- No emoji in code
- Use `rmtrash` instead of `rm`
- No lazy imports unless circular dependency exists
- Prefer reusable script files over one-off `python -c` commands
- Git commit messages concise, no Co-Authored or test stats
- Direct refactoring, no backward-compat adapter layers
- All UI/UX designs must be reviewed/approved before implementation (already approved via 06-UI-SPEC.md)
- Tech stack: TypeScript, Taro + React, NutUI React Taro components
- pnpm monorepo, ESM throughout

## Standard Stack

### Core (Feishu Mini Program)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Taro | ~3.6.39 | Mini program framework | Already installed, spike-verified on Feishu [VERIFIED: package.json] |
| React | ^18.3.1 | UI framework via Taro | Already installed [VERIFIED: package.json] |
| @tarojs/plugin-platform-lark | ^1.1.5 | Feishu compilation target | Already installed, latest 1.1.5 [VERIFIED: npm registry] |

### Core (Proxy Extensions)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @xterm/headless | ^6.0.0 | Terminal buffer text grid extraction | Already installed in proxy, provides `getLine().getCell()` API for color/style extraction [VERIFIED: npm registry, codebase] |

### Supporting (Mini Program)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Taro built-in components | ~3.6.39 | View, Text, ScrollView, Input, Button | All UI rendering [VERIFIED: spike code] |
| `tt.connectSocket` | Feishu V7.39.0+ | WebSocket connection to relay | Real-time communication [VERIFIED: Feishu docs] |
| `tt.setStorageSync` / `tt.getStorageSync` | Feishu built-in | Persistent local storage | Session cache, font size preference, proxy selection [ASSUMED] |

### NOT Needed for Mini Program
| Library | Reason |
|---------|--------|
| `@cc-anywhere/shared` (runtime) | Zod 4 runtime dependency is risky in Taro webpack5 bundle. Use TypeScript type mirrors instead. Validation stays on proxy/relay side. |
| `@nutui/nutui-react-taro` | UI-SPEC uses only Taro built-in components. No NutUI components needed for Phase 6. |
| `reconnecting-websocket` | Not applicable in mini program context. `tt.connectSocket` has its own lifecycle. Implement reconnection logic manually. |

## Architecture Patterns

### Recommended Project Structure

```
apps/feishu/src/
  pages/
    proxy-select/index.tsx     # Page 1: proxy list (from spike-typewriter)
    proxy-select/index.css
    session-list/index.tsx      # Page 2: session list (from spike-session-list)
    session-list/index.css
    chat/index.tsx              # Page 3: chat (unified PTY+JSON, from spike-chat-*)
    chat/index.css
  services/
    websocket.ts               # WebSocket connection manager (tt.connectSocket wrapper)
    relay-client.ts             # Relay protocol handler (register, select, send, receive)
    message-parser.ts           # StreamJsonEvent parser for D-19
  stores/
    app-store.ts                # Global state: connection status, selected proxy, client ID
    session-store.ts            # Session list, current session, session state
    terminal-store.ts           # PTY terminal grid data, font size
    chat-store.ts               # JSON chat messages, streaming state, tool approval queue
    command-store.ts            # Slash command list cache
    file-store.ts               # File tree cache for @file completion
  components/
    terminal-viewport/          # PTY terminal renderer (from spike-render)
    chat-bubble-list/           # JSON chat bubble list
    user-bubble/
    assistant-bubble/
    tool-call-card/
    tool-approval-card/
    slash-command-picker/       # Command picker (from spike-picker)
    file-path-picker/           # File picker (from spike-picker)
    directory-picker/           # CWD picker for new session
    input-bar/                  # Unified input bar with picker integration
    status-line/                # 4px status indicator
    back-to-bottom/
    quote-preview-bar/
    session-list-item/
    proxy-list-item/
    typewriter/                 # Brand typewriter animation (from spike-typewriter)
    empty-state/
  types/
    envelope.ts                 # TypeScript-only mirrors of MessageEnvelope types (no zod)
    relay-control.ts            # TypeScript-only mirrors of RelayControl types
    stream-json.ts              # StreamJsonEvent type definitions
    terminal.ts                 # TermLine, TermSpan types
  utils/
    relative-time.ts            # "just now", "3 min ago" formatter
    text-truncate.ts            # D-03 auto-summary, D-26 param summary
  app.config.ts                 # Page registration
  app.ts                        # App lifecycle, onLaunch WebSocket init
  app.css                       # Global styles, CSS variables
```

### Pattern 1: Mini Program State Management (React useState + Context)

**What:** Use React Context + useReducer for global state (connection, proxy selection) and local useState for page-level state. No external state library.
**When to use:** Taro mini programs have limited support for state libraries. React Context is the most reliable pattern.
**Example:**
```typescript
// services/websocket.ts -- singleton WebSocket manager
// [VERIFIED: tt.connectSocket API from Feishu docs]
import Taro from "@tarojs/taro";

let socketTask: Taro.SocketTask | null = null;
type MessageHandler = (data: string) => void;
const handlers: Set<MessageHandler> = new Set();

export function connect(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socketTask = Taro.connectSocket({ url });
    socketTask.onOpen(() => resolve());
    socketTask.onError((err) => reject(err));
    socketTask.onMessage((res) => {
      const data = typeof res.data === "string" ? res.data : "";
      for (const h of handlers) h(data);
    });
    socketTask.onClose(() => {
      socketTask = null;
      // trigger reconnect logic
    });
  });
}

export function send(data: string): void {
  socketTask?.send({ data });
}

export function onMessage(handler: MessageHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}
```

### Pattern 2: StreamJsonEvent Parsing (D-19)

**What:** Current proxy wraps StreamJsonEvent into `assistant_message.text` as JSON string. Mini program must parse this back.
**When to use:** Every assistant_message from a JSON session.
**Example:**
```typescript
// services/message-parser.ts
// [VERIFIED: serve.ts line 168-176, session-worker.ts line 51-60]

interface StreamJsonEvent {
  type: "system" | "assistant" | "user" | "result" | "control_request" | "stream_event";
  [key: string]: unknown;
}

// assistant_message.payload.text contains JSON.stringify(StreamJsonEvent)
export function parseAssistantMessage(text: string): StreamJsonEvent | null {
  try {
    return JSON.parse(text) as StreamJsonEvent;
  } catch {
    return null;
  }
}

// Route parsed events to appropriate UI updates
export function routeStreamEvent(event: StreamJsonEvent, dispatch: Dispatch) {
  switch (event.type) {
    case "assistant": {
      // event.message.content contains the text delta
      const content = (event as any).message?.content;
      if (typeof content === "string") {
        dispatch({ type: "APPEND_ASSISTANT_TEXT", text: content });
      }
      break;
    }
    case "result": {
      dispatch({ type: "MARK_TURN_COMPLETE" });
      break;
    }
    case "system": {
      // Capture Claude session ID for resume (D-35)
      const sessionId = (event as any).session_id;
      if (sessionId) {
        dispatch({ type: "SET_CLAUDE_SESSION_ID", id: sessionId });
      }
      break;
    }
    // tool_use events come as tool_use_request envelope, not inside assistant_message
  }
}
```

### Pattern 3: PTY Terminal Grid Extraction (D-08)

**What:** Extract styled text grid from @xterm/headless buffer for sending to mini program.
**When to use:** Every terminal frame push from proxy.
**Example:**
```typescript
// apps/proxy/src/terminal-tracker.ts -- new method
// [VERIFIED: xterm.js IBufferLine/IBufferCell API from xtermjs.org docs]

interface TermSpan {
  text: string;
  fg?: string;  // hex color or undefined for default
  bg?: string;
  bold?: boolean;
}

type TermLine = TermSpan[];

function cellColorToHex(cell: IBufferCell, isFg: boolean): string | undefined {
  const isDefault = isFg ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) return undefined;
  
  const isRgb = isFg ? cell.isFgRGB() : cell.isBgRGB();
  if (isRgb) {
    const color = isFg ? cell.getFgColor() : cell.getBgColor();
    return "#" + color.toString(16).padStart(6, "0");
  }
  
  const isPalette = isFg ? cell.isFgPalette() : cell.isBgPalette();
  if (isPalette) {
    // Map ANSI 256-color palette index to hex
    return ansi256ToHex(isFg ? cell.getFgColor() : cell.getBgColor());
  }
  
  return undefined;
}

extractGrid(): TermLine[] {
  const buffer = this.terminal.buffer.active;
  const lines: TermLine[] = [];
  const totalRows = buffer.length;
  
  for (let y = 0; y < totalRows; y++) {
    const bufferLine = buffer.getLine(y);
    if (!bufferLine) continue;
    
    const spans: TermSpan[] = [];
    let currentSpan: TermSpan | null = null;
    
    for (let x = 0; x < bufferLine.length; x++) {
      const cell = bufferLine.getCell(x);
      if (!cell || cell.getWidth() === 0) continue; // skip continuation cells
      
      const fg = cellColorToHex(cell, true);
      const bg = cellColorToHex(cell, false);
      const bold = !!cell.isBold();
      const chars = cell.getChars() || " ";
      
      // Merge adjacent cells with same style into one span
      if (currentSpan && currentSpan.fg === fg && currentSpan.bg === bg && currentSpan.bold === bold) {
        currentSpan.text += chars;
      } else {
        if (currentSpan) spans.push(currentSpan);
        currentSpan = { text: chars, ...(fg && { fg }), ...(bg && { bg }), ...(bold && { bold }) };
      }
    }
    if (currentSpan) spans.push(currentSpan);
    lines.push(spans);
  }
  return lines;
}
```

### Pattern 4: Relay Control Message Extension

**What:** New control message types needed for Phase 6 features.
**When to use:** Schema extensions in `packages/shared/src/schemas/`.
**New types needed:**

```typescript
// [VERIFIED: existing RelayControlSchema pattern in relay-control.ts]

// D-21: Directory listing for file picker and cwd selection
{ type: "dir_list_request", proxyId: string, path: string }
{ type: "dir_list_response", entries: Array<{ name: string; isDir: boolean }>, path: string }

// D-28: Command list push
{ type: "command_list_push", commands: Array<{ name: string; description: string; argumentHint?: string; source: string }> }

// D-29: File tree push (initial + incremental)
{ type: "file_tree_push", path: string, entries: Array<{ name: string; isDir: boolean }> }

// D-37: Session history browsing
{ type: "session_history_request" }
{ type: "session_history_response", sessions: Array<{ id: string; title: string; projectDir: string; updatedAt: number }> }

// D-38: PTY semantic state
{ type: "pty_state", sessionId: string, state: "working" | "turn_complete" | "approval_wait"; title?: string; tool?: string }
```

### Pattern 5: New MessageEnvelope Type -- terminal_frame

**What:** New envelope type for PTY terminal grid data.

```typescript
// packages/shared/src/schemas/session.ts extension
// [VERIFIED: existing PtySnapshotPayloadSchema pattern]

export const TerminalFramePayloadSchema = z.object({
  lines: z.array(z.array(z.object({
    text: z.string(),
    fg: z.string().optional(),
    bg: z.string().optional(),
    bold: z.boolean().optional(),
  }))),
});

// Add to MessageEnvelopeSchema discriminatedUnion:
// type: "terminal_frame", payload: TerminalFramePayloadSchema
```

### Anti-Patterns to Avoid

- **Don't import `@cc-anywhere/shared` in mini program runtime:** Zod 4 is a heavy dependency and Taro webpack5 may not bundle it correctly. The mini program is a consumer, not a validator. Define TypeScript-only type mirrors.
- **Don't use ScrollView for chat message list:** UI-SPEC explicitly states ScrollView has intermittent scroll-stick bug on Feishu. Use `View` + CSS `overflow-y: auto` + `-webkit-overflow-scrolling: touch`. (PTY terminal viewport can still use ScrollView for dual-axis scrolling.)
- **Don't attach touch event handlers to scroll containers:** UI-SPEC states this causes jank. Pinch-to-zoom only on PTY ScrollView (already validated in spike).
- **Don't use `tt.createAnimation` for bubble animations:** Spike proved CSS `@keyframes` is the most reliable approach.
- **Don't validate messages in mini program:** Trust proxy/relay-side validation. Mini program just parses JSON and renders.
- **Don't use delayed imports:** CLAUDE.md forbids it unless circular dependency.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| WebSocket reconnection | Custom backoff logic | Manual implementation with `tt.connectSocket` lifecycle | Mini program socket has different API than `ws` library; but the reconnection pattern is simple enough (3-5 lines of setTimeout with exponential backoff) |
| ANSI color palette mapping | Full 256-color table | Lookup table from xterm.js source or well-known npm package | 256 entries, error-prone to type manually |
| Relative time formatting | Custom date math | Simple utility (< 60s -> "just now", < 60m -> "N min ago", etc.) | Only 5 brackets needed, don't pull in a date library |
| Terminal text grid extraction | Custom ANSI parser | @xterm/headless buffer API | Already installed, provides getLine/getCell with full style info |
| Message routing on relay | Custom dispatch | Existing `routeProxyMessage` + `routeClientMessage` in router.ts | Already built, just needs new message type registration |

## Common Pitfalls

### Pitfall 1: Taro pxtransform vs Terminal Font Sizes
**What goes wrong:** Taro automatically converts `px` values via `designWidth: 750`. Terminal font sizes (8px, 10px, etc.) get transformed to responsive units, breaking fixed-size rendering.
**Why it happens:** Taro's postcss pxtransform plugin runs on all CSS by default.
**How to avoid:** Use uppercase `PX` suffix for terminal font sizes (e.g., `8PX`, `10PX`). Taro ignores uppercase PX. Already documented in UI-SPEC.
**Warning signs:** Terminal text appears too large or scales with screen size.
[VERIFIED: UI-SPEC section on font sizes, spike-chat-pty uses `PX`]

### Pitfall 2: ScrollView Scroll-Stick Bug
**What goes wrong:** Chat messages occasionally get stuck mid-scroll on Feishu real device, requiring user to tap-release to resume scrolling.
**Why it happens:** Feishu mini program ScrollView has a known intermittent scroll-stick behavior.
**How to avoid:** Use `View` + CSS `overflow-y: auto` for chat message lists. Only use ScrollView for PTY terminal (needs scrollX+scrollY).
**Warning signs:** Users report "scroll gets stuck" or "need to tap to continue scrolling".
[VERIFIED: UI-SPEC interaction contract explicitly states this]

### Pitfall 3: Zod 4 in Taro Webpack5 Bundle
**What goes wrong:** Importing `@cc-anywhere/shared` pulls in Zod 4 runtime, which may not tree-shake correctly in Taro's webpack5 config, bloating bundle or causing build errors.
**Why it happens:** Taro uses a specific webpack5 configuration that may not handle all ESM patterns.
**How to avoid:** Don't import shared package in mini program runtime code. Create TypeScript-only type mirrors. Validation happens on proxy/relay side.
**Warning signs:** Build errors about `zod`, unexpected bundle size increase, or runtime `require` failures.
[ASSUMED -- based on general Taro webpack compatibility concerns]

### Pitfall 4: StreamJsonEvent Parsing (D-19)
**What goes wrong:** Mini program tries to render assistant_message.text directly, showing raw JSON instead of formatted content.
**Why it happens:** Current serve.ts wraps StreamJsonEvent in `JSON.stringify()` inside `assistant_message.payload.text`. Mini program must unwrap it.
**How to avoid:** Always parse `assistant_message.payload.text` through `JSON.parse()` first, then route by event type.
**Warning signs:** Users see `{"type":"assistant","message":{"role":"assistant","content":"..."}}` as literal text.
[VERIFIED: serve.ts line 168-176]

### Pitfall 5: WebSocket Max 5 Connections
**What goes wrong:** If mini program opens multiple WebSocket connections (e.g., one per session), it hits Feishu's 5-connection limit.
**Why it happens:** Feishu mini program limits concurrent WebSocket connections to 5.
**How to avoid:** Use exactly ONE WebSocket connection to relay. Multiplex all sessions over this single connection (already the architecture).
**Warning signs:** `connectSocket` fails silently or returns error.
[VERIFIED: Feishu docs "Socket Maximum 5"]

### Pitfall 6: Permission Response Blocked by Session Busy
**What goes wrong:** Tool approval response gets queued behind other messages, causing timeout.
**Why it happens:** If relay treats all messages equally, permission responses may wait in queue.
**How to avoid:** D-32 mandates independent path for permission responses. Relay should forward `tool_approve`/`tool_deny` immediately without queuing.
**Warning signs:** Tool approval times out despite user clicking "Allow" promptly.
[VERIFIED: D-32 in CONTEXT.md]

### Pitfall 7: Mini Program Background/Foreground Lifecycle
**What goes wrong:** WebSocket disconnects when mini program goes to background, messages lost.
**Why it happens:** Feishu mini program suspends network connections in background.
**How to avoid:** Implement Taro `onShow` lifecycle hook to detect foreground return, check WebSocket state, reconnect if needed, request replay for missed messages via Phase 5 protocol (client_register with per-session lastSeq).
**Warning signs:** Returning to app shows stale state, messages missing.
[ASSUMED -- standard mini program behavior]

## Code Examples

### WebSocket Lifecycle in Mini Program
```typescript
// services/websocket.ts
// [VERIFIED: Feishu tt.connectSocket docs, Taro.connectSocket wrapper]

import Taro from "@tarojs/taro";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export class WebSocketManager {
  private task: Taro.SocketTask | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private url: string;
  private messageHandlers = new Set<(data: string) => void>();
  private statusHandlers = new Set<(connected: boolean) => void>();

  constructor(url: string) {
    this.url = url;
  }

  connect(): void {
    this.closed = false;
    this.doConnect();
  }

  private doConnect(): void {
    this.task = Taro.connectSocket({ url: this.url });
    
    this.task.onOpen(() => {
      this.reconnectAttempt = 0;
      this.statusHandlers.forEach(h => h(true));
    });

    this.task.onMessage((res) => {
      const data = typeof res.data === "string" ? res.data : "";
      this.messageHandlers.forEach(h => h(data));
    });

    this.task.onClose(() => {
      this.task = null;
      this.statusHandlers.forEach(h => h(false));
      if (!this.closed) this.scheduleReconnect();
    });

    this.task.onError(() => {
      // onError typically followed by onClose
    });
  }

  private scheduleReconnect(): void {
    const backoff = Math.random() * Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempt++;
      this.doConnect();
    }, backoff);
  }

  send(data: string): void {
    this.task?.send({ data });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.task?.close({});
    this.task = null;
  }

  onMessage(handler: (data: string) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatusChange(handler: (connected: boolean) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }
}
```

### Relay Client Protocol
```typescript
// services/relay-client.ts
// [VERIFIED: relay-control.ts schema, client.ts handler]

export class RelayClient {
  private ws: WebSocketManager;
  private clientId: string;
  private boundProxyId: string | null = null;
  private sessionSeqMap: Record<string, number> = {};

  constructor(ws: WebSocketManager, clientId: string) {
    this.ws = ws;
    this.clientId = clientId;
  }

  // Phase 5 client_register protocol with per-session lastSeq
  register(): void {
    this.ws.send(JSON.stringify({
      type: "client_register",
      clientId: this.clientId,
      sessions: this.sessionSeqMap,
    }));
  }

  selectProxy(proxyId: string): void {
    this.ws.send(JSON.stringify({
      type: "proxy_select",
      proxyId,
    }));
    this.boundProxyId = proxyId;
  }

  listProxies(): void {
    this.ws.send(JSON.stringify({
      type: "proxy_list_request",
    }));
  }

  // Send MessageEnvelope (user_input, tool_approve, tool_deny, etc.)
  sendEnvelope(envelope: MessageEnvelope): void {
    this.ws.send(JSON.stringify(envelope));
  }

  updateSeq(sessionId: string, seq: number): void {
    this.sessionSeqMap[sessionId] = seq;
  }
}
```

### OSC Sequence Extraction (D-38)
```typescript
// apps/proxy/src/osc-extractor.ts
// [VERIFIED: D-38/D-39 in CONTEXT.md, standard OSC escape sequence format]

// OSC 0: Set window title -- ESC ] 0 ; <title> BEL/ST
// OSC 9: Notification -- ESC ] 9 ; <text> BEL/ST
const OSC_REGEX = /\x1b\](\d+);([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;

export type PtySemanticState = "working" | "turn_complete" | "approval_wait" | "mid_pause";

export interface PtyStateEvent {
  state: PtySemanticState;
  title?: string;
  tool?: string;
}

export function extractOscSignals(rawData: string): PtyStateEvent | null {
  const matches: Array<{ code: number; text: string }> = [];
  
  let match: RegExpExecArray | null;
  while ((match = OSC_REGEX.exec(rawData)) !== null) {
    matches.push({ code: parseInt(match[1], 10), text: match[2] });
  }
  
  // OSC 9 takes priority (more specific)
  const osc9 = matches.find(m => m.code === 9);
  if (osc9) {
    if (osc9.text.includes("waiting for your input")) {
      return { state: "turn_complete" };
    }
    if (osc9.text.includes("needs your permission")) {
      // Extract tool name if available
      const toolMatch = osc9.text.match(/permission.*?:\s*(\S+)/);
      return { state: "approval_wait", tool: toolMatch?.[1] };
    }
  }
  
  // OSC 0 only (title/spinner change) -> MID_PAUSE, not forwarded
  const osc0 = matches.find(m => m.code === 0);
  if (osc0 && !osc9) {
    return { state: "mid_pause", title: osc0.text };
  }
  
  return null;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| xterm.js `serialize` addon for PTY snapshots | buffer API `getLine().getCell()` for structured text grid | Phase 6 (new) | Mini program gets styled text spans instead of raw terminal escape sequences |
| Auto-deny all tool requests (serve.ts) | Forward to relay -> mini program for user approval | Phase 6 (new) | Users can approve/deny tools from phone |
| PTY snapshot only on WORKING->IDLE | Real-time terminal frame push | Phase 6 (new) | Users see PTY output streaming on phone, not just final state |
| Single relay control messages | Extended with dir_list, command_list, file_tree, session_history, pty_state | Phase 6 (new) | Rich interaction between mini program and proxy |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Taro webpack5 may not correctly bundle Zod 4 from @cc-anywhere/shared | Anti-Patterns | If wrong (zod bundles fine), we did unnecessary work creating type mirrors. Low risk -- type mirrors are cleaner architecture anyway. |
| A2 | Feishu mini program suspends WebSocket in background | Pitfall 7 | If wrong (Feishu keeps WS alive), reconnection logic is harmless overhead. |
| A3 | `tt.setStorageSync`/`tt.getStorageSync` available in Feishu mini program | Standard Stack | If wrong, need alternative persistence. Very unlikely -- this is a standard mini program API. |
| A4 | OSC 9 notifications from Claude Code contain "waiting for your input" and "needs your permission" strings | Code Examples | If wrong, PTY semantic state extraction fails. Need to verify by observing actual Claude Code OSC output. |
| A5 | `~/.claude/projects/` directory structure is scannable for session history | D-37 implementation | If wrong, session history browsing feature won't work. Need to verify Claude Code's local storage format. |

## Open Questions (RESOLVED)

1. **Authentication flow timing** (RESOLVED -- deferred)
   - What we know: CONTEXT.md mentions "authentication flow (pairing code + long-term token) -- before or within Phase 6"
   - Resolution: Explicitly deferred. Phase 6 does not implement authentication. CONTEXT.md lists it under "Deferred Ideas". A separate mini-phase or Phase 7 will handle auth. Phase 6 connects without auth (development mode).

2. **PTY terminal frame push frequency** (RESOLVED -- Plan 05 Task 2)
   - What we know: D-08 needs real-time terminal frames, currently only WORKING->IDLE snapshots exist
   - Resolution: Plan 05 implements 200ms throttle (5fps) with `hasGridChanged()` change detection. This is a Claude's Discretion item; 200ms chosen as balance between latency and bandwidth per RESEARCH recommendation.

3. **Claude Code OSC sequence format verification** (RESOLVED -- Plan 02 Task 2)
   - What we know: D-38/D-39 specify OSC 0 and OSC 9 patterns
   - Resolution: Plan 02 implements OSC extraction with the patterns from D-39. Debug logging added in osc-extractor.ts to verify against actual Claude Code output during integration testing. If patterns don't match, the regex is easily adjustable without architectural changes.

4. **Session history file format** (RESOLVED -- Plan 05 Task 2)
   - What we know: D-37 references `~/.claude/projects/` and cc-connect's `scanSessionMeta`
   - Resolution: Plan 05 implements `scanSessionHistory()` which discovers the format at runtime by scanning `~/.claude/projects/`. The function returns empty array if the structure is unexpected, with warning logs. cc-connect's `scanSessionMeta` from reference code guides the implementation.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Taro CLI | Mini program build | Yes | ~3.6.39 | -- |
| @tarojs/plugin-platform-lark | Feishu compilation | Yes | ^1.1.5 | -- |
| @xterm/headless | PTY grid extraction | Yes | ^6.0.0 | -- |
| Feishu developer account | Mini program deployment | Unknown | -- | Use simulator for dev, real device for testing |
| Relay server (running) | WebSocket integration testing | Yes (can start locally) | -- | -- |

**Missing dependencies with no fallback:** None identified.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^4.1.2 |
| Config file | apps/feishu/vitest.config.ts (needs creation) |
| Quick run command | `pnpm --filter @cc-anywhere/feishu test` |
| Full suite command | `pnpm -r test` |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| FEISHU-01 | StreamJsonEvent parsing and routing | unit | `pnpm --filter @cc-anywhere/feishu vitest run src/__tests__/message-parser.test.ts -x` | Wave 0 |
| FEISHU-01 | Terminal grid extraction from @xterm/headless | unit | `pnpm --filter @cc-anywhere/proxy vitest run src/__tests__/terminal-grid.test.ts -x` | Wave 0 |
| FEISHU-02 | Tool approval flow (approve/deny/whitelist) | unit | `pnpm --filter @cc-anywhere/proxy vitest run src/__tests__/tool-approval.test.ts -x` | Wave 0 |
| FEISHU-03 | Session create/list/terminate via relay protocol | unit | `pnpm --filter @cc-anywhere/feishu vitest run src/__tests__/session-store.test.ts -x` | Wave 0 |
| FEISHU-04 | Reconnection and replay protocol | unit | `pnpm --filter @cc-anywhere/feishu vitest run src/__tests__/relay-client.test.ts -x` | Wave 0 |
| D-28 | Slash command discovery and filtering | unit | `pnpm --filter @cc-anywhere/proxy vitest run src/__tests__/command-discovery.test.ts -x` | Wave 0 |
| D-29 | File tree push and fs.watch | unit | `pnpm --filter @cc-anywhere/proxy vitest run src/__tests__/file-watcher.test.ts -x` | Wave 0 |
| D-38 | OSC sequence extraction | unit | `pnpm --filter @cc-anywhere/proxy vitest run src/__tests__/osc-extractor.test.ts -x` | Wave 0 |
| D-36 | Session resume with --resume --fork-session | unit | `pnpm --filter @cc-anywhere/proxy vitest run src/__tests__/session-resume.test.ts -x` | Wave 0 |
| ALL | Mini program pages render without crash | manual-only | Feishu simulator / real device | -- |

### Sampling Rate
- **Per task commit:** Quick run for modified package
- **Per wave merge:** Full suite `pnpm -r test`
- **Phase gate:** Full suite green + Feishu simulator visual check

### Wave 0 Gaps
- [ ] `apps/feishu/vitest.config.ts` -- vitest config for feishu package
- [ ] `apps/feishu/src/__tests__/message-parser.test.ts` -- StreamJsonEvent parsing
- [ ] `apps/feishu/src/__tests__/session-store.test.ts` -- session state management
- [ ] `apps/feishu/src/__tests__/relay-client.test.ts` -- relay protocol handling
- [ ] `apps/proxy/src/__tests__/terminal-grid.test.ts` -- terminal grid extraction
- [ ] `apps/proxy/src/__tests__/tool-approval.test.ts` -- tool approval forwarding
- [ ] `apps/proxy/src/__tests__/command-discovery.test.ts` -- slash command discovery
- [ ] `apps/proxy/src/__tests__/file-watcher.test.ts` -- file tree monitoring
- [ ] `apps/proxy/src/__tests__/osc-extractor.test.ts` -- OSC signal extraction
- [ ] `apps/proxy/src/__tests__/session-resume.test.ts` -- session resume

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | Partial | Shared secret / pairing code (deferred, but relay WebSocket needs some form of auth) |
| V3 Session Management | Yes | clientId + proxyId binding via relay, session-level tool whitelist cleared on termination |
| V4 Access Control | Yes | Proxy only accepts messages from bound client via relay; tool whitelist is session-scoped |
| V5 Input Validation | Yes | Zod validation on proxy/relay side; mini program trusts validated messages |
| V6 Cryptography | No | WSS (TLS) handles transport encryption |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Unauthorized tool approval | Elevation of Privilege | Session-level clientId binding; relay only forwards from authenticated client |
| Message injection via WebSocket | Tampering | Zod schema validation on proxy/relay; envelope source field checked |
| Session hijacking | Spoofing | clientId persistence + proxyId binding; Phase 7+ will add proper auth |
| Directory traversal via dir_list_request | Information Disclosure | Proxy should validate and sanitize requested paths, restrict to allowed roots |
| Tool whitelist persistence beyond session | Elevation of Privilege | D-27: whitelist cleared when session ends |

## Sources

### Primary (HIGH confidence)
- Codebase: `packages/shared/src/schemas/*.ts` -- all 16 message types and relay control schema
- Codebase: `apps/proxy/src/serve.ts` -- current message routing and auto-deny tool approval
- Codebase: `apps/proxy/src/session-worker.ts` -- worker IPC and approval strategy
- Codebase: `apps/proxy/src/terminal-tracker.ts` -- existing @xterm/headless integration
- Codebase: `apps/relay/src/router.ts` -- message routing and replay handling
- Codebase: `apps/relay/src/handlers/client.ts` -- client register/select/replay protocol
- Codebase: All spike pages (`spike-render`, `spike-chat-json`, `spike-chat-pty`, `spike-session-list`, `spike-picker`, `spike-bubble-anim`, `spike-typewriter`) -- validated rendering patterns
- [Feishu tt.connectSocket API](https://open.feishu.cn/document/uYjL24iN/ugDMx4COwEjL4ATM) -- WebSocket API, max 5 connections
- [xterm.js IBufferCell API](https://xtermjs.org/docs/api/terminal/interfaces/ibuffercell/) -- cell color and style extraction
- [xterm.js IBufferLine API](https://xtermjs.org/docs/api/terminal/interfaces/ibufferline/) -- line iteration

### Secondary (MEDIUM confidence)
- [Taro.connectSocket docs](https://docs.taro.zone/en/docs/apis/network/websocket/connectSocket) -- Taro wrapper API
- [Taro useRouter hook](https://docs.taro.zone/en/docs/hooks) -- routing in functional components
- [Taro navigateTo](https://docs.taro.zone/en/docs/apis/route/navigateTo) -- page navigation
- npm registry: @tarojs/taro 4.1.11 (latest), @xterm/headless 6.0.0 (latest), @tarojs/plugin-platform-lark 1.1.5 (latest)

### Tertiary (LOW confidence)
- OSC sequence format for Claude Code (D-38/D-39) -- based on CONTEXT.md decisions, not verified against actual Claude Code output
- `~/.claude/projects/` directory structure (D-37) -- based on cc-connect reference, not verified locally

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries already installed and spike-verified
- Architecture: HIGH -- spike prototypes validated all critical rendering patterns on Feishu real device
- Proxy extensions: HIGH -- existing infrastructure (terminal-tracker, session-worker, relay-connection) provides clear extension points
- Mini program WebSocket: HIGH -- Feishu docs confirmed, Taro wrapper available
- PTY semantic signals (D-38/D-39): MEDIUM -- depends on Claude Code's actual OSC output format
- Session history scanning (D-37): MEDIUM -- depends on Claude Code local storage format

**Research date:** 2026-04-08
**Valid until:** 2026-05-08 (stable -- Taro 3.6 and @xterm/headless 6.0 are mature releases)
