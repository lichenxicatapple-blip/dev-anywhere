---
phase: 06-feishu-mini-program-core-interaction
plan: 08
subsystem: feishu-chat-page
tags: [chat, pty, json, dual-mode, input-bar, terminal-viewport, responsive]
dependency_graph:
  requires: ["06-06 message-parser", "06-10 stores/hooks/components"]
  provides: ["chat page with PTY/JSON dual rendering", "input bar with D-33 logic", "terminal viewport", "chat bubble list"]
  affects: ["06-09 advanced chat features"]
tech_stack:
  added: []
  patterns: ["computeSendDisabled pure function extraction", "dual-mode page with conditional rendering", "View overflow-y instead of ScrollView for chat list"]
key_files:
  created:
    - apps/feishu/src/pages/chat/index.tsx
    - apps/feishu/src/pages/chat/index.css
    - apps/feishu/src/pages/chat/index.config.ts
    - apps/feishu/src/components/terminal-viewport/index.tsx
    - apps/feishu/src/components/terminal-viewport/index.css
    - apps/feishu/src/components/chat-bubble-list/index.tsx
    - apps/feishu/src/components/chat-bubble-list/index.css
    - apps/feishu/src/components/user-bubble/index.tsx
    - apps/feishu/src/components/user-bubble/index.css
    - apps/feishu/src/components/assistant-bubble/index.tsx
    - apps/feishu/src/components/assistant-bubble/index.css
    - apps/feishu/src/components/input-bar/index.tsx
    - apps/feishu/src/components/input-bar/index.css
    - apps/feishu/src/__tests__/input-bar-logic.test.ts
  modified:
    - apps/feishu/config/index.ts
decisions:
  - "Added @/ path alias to Taro webpack config to match tsconfig paths"
  - "ChatBubbleList uses View overflow-y instead of ScrollView per UI-SPEC scroll-stick warning"
  - "Tool calls render as simple text placeholders, full ToolCallCard deferred to Plan 09"
  - "Stub pages created for proxy-select, session-list, spike-render to unblock build in worktree"
metrics:
  duration: "9min"
  completed: "2026-04-10"
  tasks_completed: 3
  tasks_total: 3
---

# Phase 06 Plan 08: Chat Page Dual Mode Summary

Chat page with PTY terminal viewport and JSON chat bubbles, custom SafeAreaHeader navigation, InputBar with tested D-33 disabled-state logic, and responsive layout across phone/landscape/desktop.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 (RED) | bfa86f8 | Failing tests for computeSendDisabled |
| 1 (GREEN) | 2426fcb | PTY terminal viewport, chat bubble list, input bar with tested logic |
| 2 | 8db6342 | Chat page with dual mode, custom navigation, responsive layout |

## What Was Built

### InputBar with D-33 Logic (Task 1)
- `computeSendDisabled` pure function: JSON mode disables send when working or pending approvals; PTY mode always enabled
- 5 unit tests covering all combinations
- InputBar component: menu button, text input with adjustPosition, send button with active/disabled states
- Disabled reason text shown above input bar when Claude is working

### Terminal Viewport (Task 1)
- Evolved from spike-chat-pty pattern: ScrollView with dual-axis scrolling
- TermLine[] rendering with colored spans, monospace font, uppercase PX to bypass pxtransform
- Pinch-to-zoom detection triggering font size change callbacks
- Auto-scroll to bottom on new lines

### Chat Bubble List (Task 1)
- Uses View with overflow-y auto (NOT ScrollView, per UI-SPEC scroll-stick warning)
- UserBubble: right-aligned, blue background, responsive max-width via CSS variable
- AssistantBubble: left-aligned, gray background, streaming cursor when isPartial
- Bubble entrance animations (CSS keyframes): assistant 350ms bounce, user 250ms slide
- Tap to show/hide timestamp on each bubble
- Tool calls rendered as text lines (full ToolCallCard deferred to Plan 09)

### Chat Page (Task 2)
- Per-page config: `navigationStyle: "custom"`, `pageOrientation: "auto"`, `disableScroll: true`
- SafeAreaHeader with statusBarHeight padding, transparent mode for PTY dark theme
- Mode switching: PTY renders TerminalViewport, JSON renders ChatBubbleList
- Message dispatch handlers for terminal_frame, pty_state, assistant_message, tool_use_request, tool_result, session_status
- StatusLine state mapped from PTY/JSON session state
- Responsive layout: desktop uses 800px max-width centered container for content and input bar

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added @/ path alias to Taro webpack config**
- **Found during:** Task 1
- **Issue:** tsconfig.json had `@/*` path alias but Taro webpack build couldn't resolve it, causing import failures
- **Fix:** Added `alias: { "@": path.resolve(__dirname, "..", "src") }` to Taro config
- **Files modified:** apps/feishu/config/index.ts
- **Commit:** 2426fcb

**2. [Rule 3 - Blocking] Created stub pages for proxy-select, session-list, spike-render**
- **Found during:** Task 2
- **Issue:** app.config.ts registers pages created by parallel Plan 07/09 agents, but they don't exist in this worktree
- **Fix:** Created minimal stub pages to unblock build verification
- **Files created:** apps/feishu/src/pages/proxy-select/index.tsx, apps/feishu/src/pages/session-list/index.tsx, apps/feishu/src/pages/spike-render/index.tsx
- **Commit:** 8db6342

## Verification

- [x] `vitest run input-bar-logic.test.ts` -- 5/5 tests pass
- [x] `build:lark` -- compiles successfully
- [x] Chat page config has `navigationStyle: "custom"` and `pageOrientation: "auto"`
- [x] TerminalViewport renders TermLine[] with colored spans
- [x] ChatBubbleList uses View overflow (not ScrollView)
- [x] InputBar disables per D-33 rules (JSON only)
- [x] Responsive CSS variables applied at breakpoints

## Self-Check: PASSED

All 14 created files verified present. All 3 commits (bfa86f8, 2426fcb, 8db6342) verified in git log.
