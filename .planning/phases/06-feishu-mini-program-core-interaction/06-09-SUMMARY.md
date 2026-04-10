---
phase: 06-feishu-mini-program-core-interaction
plan: 09
subsystem: feishu-chat-enhancements
tags: [tool-approval, tool-call-card, back-to-bottom, summarize-tool-input]
dependency_graph:
  requires: ["06-08 chat page dual mode", "06-06 message-parser"]
  provides: ["tool approval card with three buttons", "collapsible tool call cards", "back-to-bottom floating button", "summarizeToolInput tested helper"]
  affects: ["06-10 stores/hooks wiring"]
tech_stack:
  added: []
  patterns: ["summarizeToolInput pure function for tool param rendering", "PTY overlay for tool approval", "inline approval cards in JSON mode"]
key_files:
  created:
    - apps/feishu/src/utils/summarize-tool-input.ts
    - apps/feishu/src/components/tool-approval-card/index.tsx
    - apps/feishu/src/components/tool-approval-card/index.css
    - apps/feishu/src/components/tool-call-card/index.tsx
    - apps/feishu/src/components/tool-call-card/index.css
    - apps/feishu/src/components/back-to-bottom/index.tsx
    - apps/feishu/src/components/back-to-bottom/index.css
    - apps/feishu/src/__tests__/summarize-tool-input.test.ts
  modified:
    - apps/feishu/src/pages/chat/index.tsx
    - apps/feishu/src/pages/chat/index.css
    - apps/feishu/src/components/assistant-bubble/index.tsx
    - apps/feishu/src/components/chat-bubble-list/index.tsx
decisions:
  - "summarizeToolInput extracted to utils/ as standalone pure function for testability and reuse across both ToolApprovalCard and ToolCallCard"
  - "ToolApprovalCard double-tap prevention via local acted state plus store status check (T-06-27 mitigation)"
  - "AssistantBubble upgraded from placeholder tool text lines to proper ToolCallCard components"
metrics:
  duration: "7min"
  completed: "2026-04-10"
  tasks_completed: 3
  tasks_total: 3
---

# Phase 06 Plan 09: Tool Approval, Tool Call Cards, Back-to-Bottom Summary

Tool approval card with three-button UI (allow/allow-all/deny) and two-layer param rendering, collapsible tool call cards replacing placeholder text, back-to-bottom floating button, all integrated into chat page with PTY overlay and JSON inline modes. summarizeToolInput helper unit tested for Edit/Bash/Write/generic tools.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 (RED) | 0ed64d2 | Failing tests for summarizeToolInput |
| 1 (GREEN) | 8c8a1fc | ToolApprovalCard, ToolCallCard, BackToBottomButton, summarizeToolInput helper |
| 2 | d917a31 | Integrate all components into chat page |

## What Was Built

### summarizeToolInput Helper (Task 1)
- Pure function recognizing Edit/edit_file, Bash/execute, Write/write_file, and generic tools
- Returns typed ToolSummary with type, summary string (truncated at 80 chars), and details
- 6 unit tests covering all tool types, truncation, and variant names

### ToolApprovalCard (Task 1)
- Yellow background (#FFFBE6) with warning border per UI-SPEC
- Two-layer param rendering: Edit shows diff colors (red remove, green add), Bash shows terminal style (dark background, green prompt), Write shows file path + content, generic shows JSON
- Three buttons: Allow (#52C41A), Allow All (#1890FF), Deny (white with red border)
- Double-tap prevention: buttons become non-interactive after first tap (T-06-27)
- Resolved states: approved collapses to ToolCallCard style, denied shows red marker

### ToolCallCard (Task 1)
- Collapsed (default): wrench icon + tool name (semi-bold) + truncated params (40 chars, #999999)
- Expanded: tool name header + pre-formatted JSON params (monospace, scrollable 200px max) + result if available
- Background #FAFAFA, border #E8E8E8, 8px border-radius

### BackToBottomButton (Task 1)
- Fixed position, bottom-right, 36px circle with down arrow
- Fade-in/slide-up 200ms entrance, fade-out 200ms exit via CSS transitions
- Visibility controlled by parent via isNearBottom state

### Chat Page Integration (Task 2)
- JSON mode: ToolApprovalCard rendered inline below ChatBubbleList for pending approvals
- PTY mode: full-page overlay (fixed, rgba(0,0,0,0.4)) with centered ToolApprovalCard when ptyState === "approval_wait"
- AssistantBubble upgraded from placeholder tool text to ToolCallCard components
- ChatBubbleList passes onToggleToolCollapse through to AssistantBubble
- BackToBottomButton wired to scroll threshold from ChatBubbleList
- StatusLine maps PTY/JSON states to status indicator

## Known Stubs

| File | Line | Description | Resolution |
|------|------|-------------|------------|
| apps/feishu/src/pages/chat/index.tsx | 90 | TODO: relay client sendEnvelope for user_input | Plan 10 wires stores to relay client |
| apps/feishu/src/pages/chat/index.tsx | 120,128,136 | TODO: relay client sendEnvelope for tool_approve/deny | Plan 10 wires stores to relay client |
| apps/feishu/src/pages/chat/index.tsx | 149 | TODO: slash command picker | Future plan for command completion UI |

These TODOs represent relay client wiring that depends on Plan 10's store integration. The UI components are complete and functional.

## Deviations from Plan

None - plan executed exactly as written.

## Verification

- [x] `vitest run summarize-tool-input.test.ts` -- 6/6 tests pass
- [x] All feishu tests pass (46/46)
- [x] `build:lark` compiles successfully
- [x] ToolApprovalCard renders with three buttons and two-layer param preview
- [x] ToolCallCard collapses/expands with param summary
- [x] BackToBottomButton shows/hides via CSS transition
- [x] PTY overlay renders with fixed positioning and dark background
- [x] JSON inline approval cards render below bubble list

## Self-Check: PASSED

All 8 created files and 4 modified files verified present. All 3 commits (0ed64d2, 8c8a1fc, d917a31) verified in git log.
