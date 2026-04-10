---
phase: 06-feishu-mini-program-core-interaction
reviewed: 2026-04-10T12:16:56Z
depth: standard
files_reviewed: 55
files_reviewed_list:
  - apps/feishu/src/app.tsx
  - apps/feishu/src/app.config.ts
  - apps/feishu/src/types/stream-json.ts
  - apps/feishu/src/services/websocket.ts
  - apps/feishu/src/services/relay-client.ts
  - apps/feishu/src/services/message-parser.ts
  - apps/feishu/src/stores/app-store.ts
  - apps/feishu/src/stores/chat-store.ts
  - apps/feishu/src/stores/command-store.ts
  - apps/feishu/src/stores/file-store.ts
  - apps/feishu/src/stores/relay-store.ts
  - apps/feishu/src/stores/session-store.ts
  - apps/feishu/src/stores/terminal-store.ts
  - apps/feishu/src/hooks/use-screen-size.ts
  - apps/feishu/src/utils/relative-time.ts
  - apps/feishu/src/utils/summarize-tool-input.ts
  - apps/feishu/src/utils/text-truncate.ts
  - apps/feishu/src/components/terminal-viewport/index.tsx
  - apps/feishu/src/components/input-bar/index.tsx
  - apps/feishu/src/components/tool-approval-card/index.tsx
  - apps/feishu/src/components/tool-call-card/index.tsx
  - apps/feishu/src/components/back-to-bottom/index.tsx
  - apps/feishu/src/components/slash-command-picker/index.tsx
  - apps/feishu/src/components/file-path-picker/index.tsx
  - apps/feishu/src/components/directory-picker/index.tsx
  - apps/feishu/src/components/directory-picker/path-utils.ts
  - apps/feishu/src/components/quote-preview-bar/index.tsx
  - apps/feishu/src/components/typewriter/index.tsx
  - apps/feishu/src/components/session-list-item/index.tsx
  - apps/feishu/src/components/assistant-bubble/index.tsx
  - apps/feishu/src/components/user-bubble/index.tsx
  - apps/feishu/src/components/chat-bubble-list/index.tsx
  - apps/feishu/src/components/empty-state/index.tsx
  - apps/feishu/src/components/proxy-list-item/index.tsx
  - apps/feishu/src/components/safe-area-header/index.tsx
  - apps/feishu/src/components/status-line/index.tsx
  - apps/feishu/src/pages/proxy-select/index.tsx
  - apps/feishu/src/pages/proxy-select/index.config.ts
  - apps/feishu/src/pages/session-list/index.tsx
  - apps/feishu/src/pages/session-list/index.config.ts
  - apps/feishu/src/pages/chat/index.tsx
  - apps/feishu/src/pages/chat/index.config.ts
  - apps/feishu/src/pages/index/index.tsx
  - apps/feishu/src/pages/spike-hub/index.tsx
  - apps/feishu/src/pages/spike-typewriter/index.tsx
  - apps/feishu/src/pages/spike-session-list/index.tsx
  - apps/feishu/src/pages/spike-session-list/index.config.ts
  - apps/feishu/src/pages/spike-chat-json/index.tsx
  - apps/feishu/src/pages/spike-chat-json/index.config.ts
  - apps/feishu/src/pages/spike-chat-pty/index.tsx
  - apps/feishu/src/pages/spike-chat-pty/index.config.ts
  - apps/feishu/src/pages/spike-bubble-anim/index.tsx
  - apps/feishu/src/pages/spike-picker/index.tsx
  - apps/feishu/src/pages/spike-typewriter/index.config.ts
  - apps/feishu/src/pages/spike-render/index.tsx
findings:
  critical: 4
  warning: 9
  info: 6
  total: 19
status: issues_found
---

# Phase 06: Code Review Report

**Reviewed:** 2026-04-10T12:16:56Z
**Depth:** standard
**Files Reviewed:** 55
**Status:** issues_found

## Summary

Reviewed the entire Feishu mini program source tree produced during Phase 06: services (websocket, relay-client, message-parser), 7 stores, 16 components, 3 production pages, 8 spike pages, hooks, utils, and types.

The architecture is clean -- context-based stores with reducers, separated services, extracted utility functions. However, there are several critical bugs (one compile-breaking reference error, one user message never sent to the relay, duplicate WebSocket connections on reconnect, and a data loss race in tool result matching), plus warnings around missing error handling, incomplete feature wiring, and type safety issues.

## Critical Issues

### CR-01: Chat page never sends user messages to relay -- dead TODO

**File:** `apps/feishu/src/pages/chat/index.tsx:107`
**Issue:** The `handleSend` callback adds the user message to local state and sets `isWorking: true`, but never sends anything to the relay server. Line 107 has `// TODO: relay client sendEnvelope with user_input`. This means the entire chat page is non-functional -- users type messages that go nowhere. The relay client is available in scope (`relay` from `useRelayClient()`) but is never called.
**Fix:**
```typescript
// After chatDispatch calls, add:
if (relay) {
  relay.sendEnvelope({
    type: "user_input",
    sessionId,
    payload: { text: finalText },
  } as MessageEnvelope);
}
```
Also remove the TODO comment after implementing.

### CR-02: WebSocket duplicate connections on foreground resume

**File:** `apps/feishu/src/services/websocket.ts:17-21` and `apps/feishu/src/app.tsx:50-56`
**Issue:** `WebSocketManager.connect()` calls `doConnect()` without closing an existing `this.task`. If the previous socket is still in a connecting or open state, this creates a parallel WebSocket connection. The `useDidShow` handler in app.tsx calls `ws.connect(url)` when `!ws.isConnected()`, but `isConnected` is only `true` after `onOpen`. During the exponential backoff reconnect window, the socket may be in a pending state (task exists but not yet open, `connected === false`). Calling `connect()` again creates a duplicate.
**Fix:**
```typescript
// In WebSocketManager.connect():
connect(url: string): void {
  this.url = url;
  this.closed = false;
  // Close existing connection before creating a new one
  if (this.task) {
    this.task.close({});
    this.task = null;
  }
  if (this.reconnectTimer) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
  this.doConnect();
}
```

### CR-03: UPDATE_TOOL_RESULT matches by toolName -- updates wrong tool call when duplicates exist

**File:** `apps/feishu/src/stores/chat-store.ts:101-114`
**Issue:** The `UPDATE_TOOL_RESULT` action matches tool calls by `toolName` (line 109: `tc.toolName === action.toolName`). If a message has multiple tool calls with the same tool name (e.g., two `Read` calls, two `Bash` calls), the result is applied to the first match only, and subsequent results overwrite it. The action should match by a unique tool call index or ID.
**Fix:** Add a `toolIndex` field to the action instead of `toolName`:
```typescript
// Action type change:
| { type: "UPDATE_TOOL_RESULT"; messageId: string; toolIndex: number; output: string }

// Reducer:
case "UPDATE_TOOL_RESULT":
  return {
    ...state,
    messages: state.messages.map((m) =>
      m.id === action.messageId
        ? {
            ...m,
            toolCalls: m.toolCalls.map((tc, i) =>
              i === action.toolIndex ? { ...tc, output: action.output } : tc,
            ),
          }
        : m,
    ),
  };
```

### CR-04: spike-picker references undefined `setInsertedPaths` -- compile error

**File:** `apps/feishu/src/pages/spike-picker/index.tsx:335,346`
**Issue:** `handleSelectFile` calls `setInsertedPaths((prev) => [...prev, token])` and `handleSend` calls `setInsertedPaths([])`, but the state is declared as `const [insertedTokens, setInsertedTokens] = useState<string[]>([])` on line 250. `setInsertedPaths` does not exist. This will cause a runtime crash or compile error.
**Fix:** Replace `setInsertedPaths` with `setInsertedTokens` on lines 335 and 346.

## Warnings

### WR-01: app.tsx stale closure captures initial `state.clientId` in useEffect

**File:** `apps/feishu/src/app.tsx:33,47`
**Issue:** The `useEffect` on line 22 has an empty dependency array `[]` but references `state.clientId` on line 33. This captures the initial value, which is correct for `clientId` (it never changes after initialization). However, the empty deps array means ESLint's exhaustive-deps rule would flag this. More importantly, if `state.clientId` ever did change (e.g., user cleared storage), the RelayClient would use the stale ID. The intent is correct but fragile.
**Fix:** Extract `clientId` from the module-level `initialAppState.clientId` constant directly instead of `state.clientId`, or add `state.clientId` to the dependency array.

### WR-02: `as never` type assertions bypass type checking in session-list

**File:** `apps/feishu/src/pages/session-list/index.tsx:91,106,137`
**Issue:** Three calls to `relay.sendEnvelope()` use `as never` to bypass TypeScript's type checking. This silences legitimate type errors -- the objects being sent (`session_terminate`, `session_create`) may not conform to the `MessageEnvelope` schema, which could cause the relay to reject them at runtime.
**Fix:** Define proper MessageEnvelope-typed objects matching the shared schema, or use `relay.sendControl()` if these are control messages rather than envelopes.

### WR-03: Chat page `handleBackToBottom` does not actually scroll

**File:** `apps/feishu/src/pages/chat/index.tsx:116-118`
**Issue:** `handleBackToBottom` sets `setIsNearBottom(true)` which hides the button, but never triggers an actual scroll. The `ChatBubbleList` auto-scrolls only when `messages.length` changes (line 55-58 of chat-bubble-list). Pressing "back to bottom" hides the button without scrolling, leaving the user at their current position.
**Fix:** Expose a `scrollToBottom` imperative handle from `ChatBubbleList` via `useImperativeHandle`/`forwardRef`, or pass a `scrollToBottomTrigger` counter prop that the list watches in a useEffect.

### WR-04: message-parser `routeStreamEvent` uses unsafe type assertion

**File:** `apps/feishu/src/services/message-parser.ts:24`
**Issue:** `(event.text as string) ?? ""` asserts `event.text` as string, but `StreamJsonEvent` has `[key: string]: unknown` -- if `event.text` is `undefined`, the `as string` assertion still produces `undefined`, and the `??` operator then returns `""`. However, if `event.text` is a number or object, `as string` will silently pass the wrong type through. A proper guard like `typeof event.text === "string" ? event.text : ""` is safer.
**Fix:**
```typescript
case "assistant":
  return {
    type: "APPEND_ASSISTANT_TEXT",
    text: typeof event.text === "string" ? event.text : "",
  };
```

### WR-05: Typewriter component crashes on empty `texts` array

**File:** `apps/feishu/src/components/typewriter/index.tsx:32`
**Issue:** `const currentText = () => texts[textIdx.current % texts.length]` -- if `texts` is an empty array, `texts.length` is 0, causing division by zero in the modulo operation. `0 % 0` is `NaN` in JavaScript, and `texts[NaN]` is `undefined`. The subsequent `text.length` access on line 37 will throw a TypeError.
**Fix:** Add an early return guard:
```typescript
if (texts.length === 0) {
  return <View className="typewriter-container" />;
}
```

### WR-06: WebSocket `send()` silently drops messages when disconnected

**File:** `apps/feishu/src/services/websocket.ts:59-61`
**Issue:** `send(data)` uses optional chaining `this.task?.send({ data })`, which silently drops the message if `task` is null (during reconnection). Callers like `RelayClient.register()` and `RelayClient.sendEnvelope()` have no way to know the message was dropped. For registration and user input, silent loss is a bug.
**Fix:** Either queue messages during disconnection for replay on reconnect, or throw/return an error so callers can handle it:
```typescript
send(data: string): boolean {
  if (!this.task || !this.connected) {
    console.warn("WebSocketManager: message dropped, not connected");
    return false;
  }
  this.task.send({ data });
  return true;
}
```

### WR-07: Two `onStatusChange` handlers registered in app.tsx

**File:** `apps/feishu/src/app.tsx:29-31,36-39`
**Issue:** Two separate `onStatusChange` handlers are registered. The first dispatches `SET_CONNECTED`. The second calls `relay.register()` on connect. Both fire on every status change. This is not a bug per se, but duplicates work: every disconnect/reconnect invokes two separate handler iterations of the `statusHandlers` Set. Consolidate into one handler for clarity and to avoid double iteration.
**Fix:**
```typescript
ws.onStatusChange((connected) => {
  dispatch({ type: "SET_CONNECTED", connected });
  if (connected) {
    relay.register();
  }
});
```

### WR-08: `handleToolAllowAll` is identical to `handleToolAllow` -- "Allow All" not implemented

**File:** `apps/feishu/src/pages/chat/index.tsx:138-143`
**Issue:** Both `handleToolAllow` and `handleToolAllowAll` do the exact same thing -- they dispatch `UPDATE_APPROVAL_STATUS` for a single request. "Allow All" should approve all pending approvals (or send a control message to change permission mode), but currently it only approves the one clicked.
**Fix:** `handleToolAllowAll` should iterate all pending approvals:
```typescript
const handleToolAllowAll = useCallback(
  (_requestId: string) => {
    chatState.pendingApprovals
      .filter((a) => a.status === "pending")
      .forEach((a) => {
        chatDispatch({ type: "UPDATE_APPROVAL_STATUS", requestId: a.requestId, status: "approved" });
      });
  },
  [chatDispatch, chatState.pendingApprovals],
);
```

### WR-09: Proxy auto-navigate skips session-list, navigates directly to chat without session context

**File:** `apps/feishu/src/pages/proxy-select/index.tsx:52`
**Issue:** The D-02 cold start auto-navigation navigates directly to `/pages/chat/index` without setting `currentSessionId` in session store. The chat page reads `sessionId` from `router.params.sessionId` (line 53 of chat/index.tsx), which will be empty string since no params were passed. The saved `cc_sessionId` in storage is checked but never passed as a navigation param.
**Fix:** Pass the session ID as a query parameter:
```typescript
Taro.navigateTo({ url: `/pages/chat/index?sessionId=${savedSessionId}` });
```

## Info

### IN-01: console.log left in spike page

**File:** `apps/feishu/src/pages/index/index.tsx:13`
**Issue:** `console.log("[spike] Index page rendered")` -- debug logging left in source.
**Fix:** Remove the console.log line.

### IN-02: Spike pages use Chinese UI text inconsistently

**Files:** `apps/feishu/src/pages/spike-chat-pty/index.tsx:212,221,224,227,241,256,258` and `apps/feishu/src/pages/spike-chat-json/index.tsx:120,262,278,303,318`
**Issue:** Spike pages mix Chinese UI text (e.g., "需要工具审批", "允许", "输入消息...") with English. The production components (tool-approval-card, input-bar) correctly use English. While spike pages are prototypes, the inconsistency may cause confusion when referencing them.
**Fix:** Align spike pages to English UI text to match production components, or mark them clearly as i18n candidates.

### IN-03: `ToolApprovalCard` accepts `sessionMode` prop but ignores it

**File:** `apps/feishu/src/components/tool-approval-card/index.tsx:14,21`
**Issue:** The `sessionMode` prop is declared in the interface (line 14) but destructured away (line 21 -- not included in the destructuring). This is dead interface surface that misleads readers about the component's capabilities.
**Fix:** Either remove `sessionMode` from the interface, or implement mode-specific behavior (e.g., different approval actions for PTY vs JSON mode).

### IN-04: `ChatBubbleList` uses `HTMLDivElement` refs in mini program context

**File:** `apps/feishu/src/components/chat-bubble-list/index.tsx:24-25`
**Issue:** `useRef<HTMLDivElement>(null)` -- Taro mini programs do not have `HTMLDivElement`. This works in Taro's H5 compilation target but may cause issues in the Feishu mini program runtime where refs to Taro `View` components have a different API. The `scrollIntoView` call on line 57 may silently fail.
**Fix:** Use Taro's `createSelectorQuery` or `ScrollView` with `scrollIntoView` prop for mini program compatibility.

### IN-05: `spike-render` page referenced in spike-hub but does not exist

**File:** `apps/feishu/src/pages/spike-hub/index.tsx:12`
**Issue:** The spike hub links to `/pages/spike-render/index` but this page directory does not exist yet (only appears as untracked in git status). Navigating to it will fail at runtime.
**Fix:** Either add the spike-render page or remove it from the spike hub list until ready.

### IN-06: `formatRelativeTime` returns "1 days ago" for exactly 1 day

**File:** `apps/feishu/src/utils/relative-time.ts:7`
**Issue:** When `seconds` is between 86400 and 172800, the function returns "1 days ago" -- incorrect English pluralization. Should be "1 day ago".
**Fix:**
```typescript
const days = Math.floor(seconds / 86400);
return days === 1 ? "1 day ago" : `${days} days ago`;
```
Apply the same fix for hours and minutes: "1 min ago" and "1 hr ago" are acceptable abbreviations but "1 days ago" is not.

---

_Reviewed: 2026-04-10T12:16:56Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
