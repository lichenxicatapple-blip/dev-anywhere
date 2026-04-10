---
phase: 06-feishu-mini-program-core-interaction
plan: 11
subsystem: feishu-mini-program
tags: [pickers, quoting, settings, directory-picker, responsive]
dependency_graph:
  requires: [06-09, 06-10]
  provides: [slash-command-picker, file-path-picker, quote-preview-bar, directory-picker, settings-menu]
  affects: [chat-page, session-list, input-bar, user-bubble, assistant-bubble, chat-bubble-list]
tech_stack:
  added: []
  patterns: [path-utils-extraction, atomic-token-delete, long-press-context-menu, xml-quote-injection]
key_files:
  created:
    - apps/feishu/src/components/directory-picker/index.tsx
    - apps/feishu/src/components/directory-picker/index.css
    - apps/feishu/src/components/directory-picker/path-utils.ts
    - apps/feishu/src/components/slash-command-picker/index.tsx
    - apps/feishu/src/components/slash-command-picker/index.css
    - apps/feishu/src/components/file-path-picker/index.tsx
    - apps/feishu/src/components/file-path-picker/index.css
    - apps/feishu/src/components/quote-preview-bar/index.tsx
    - apps/feishu/src/components/quote-preview-bar/index.css
    - apps/feishu/src/__tests__/directory-picker.test.ts
  modified:
    - apps/feishu/src/components/input-bar/index.tsx
    - apps/feishu/src/components/input-bar/index.css
    - apps/feishu/src/components/user-bubble/index.tsx
    - apps/feishu/src/components/user-bubble/index.css
    - apps/feishu/src/components/assistant-bubble/index.tsx
    - apps/feishu/src/components/assistant-bubble/index.css
    - apps/feishu/src/components/chat-bubble-list/index.tsx
    - apps/feishu/src/pages/chat/index.tsx
    - apps/feishu/src/pages/chat/index.css
    - apps/feishu/src/pages/session-list/index.tsx
decisions:
  - Extracted path utils into separate path-utils.ts to keep pure functions testable without React dependency
metrics:
  duration: 11min
  completed: "2026-04-10T09:28:03Z"
  tasks_completed: 3
  files_created: 10
  files_modified: 10
---

# Phase 06 Plan 11: Advanced Chat Features and Session Creation Summary

Slash/file command pickers, message quoting with XML injection, settings menu with PC window toggle, and DirectoryPicker for new session cwd selection with tested path logic.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | c89ddd1 | DirectoryPicker, SlashCommandPicker, FilePathPicker with 7 tested path util functions |
| 2 | 636e260 | QuotePreviewBar, settings menu, picker integration in chat page, DirectoryPicker in session list |
| 3 | -- | Auto-approved checkpoint (auto_advance=true) |

## Task Details

### Task 1: Pickers and DirectoryPicker with TDD

**TDD flow:** Extracted path utils (buildBreadcrumbSegments, buildParentPath, joinPath) into `path-utils.ts` separate from the React component. Tests import pure functions without needing React/Taro dependencies. 7 tests pass.

**DirectoryPicker**: Modal overlay with breadcrumb navigation, directory listing, Select/Return buttons. Uses `dir_list_request` control messages for lazy loading. Responsive max-width via `--picker-max-width` CSS variable.

**SlashCommandPicker**: Slide-up panel triggered by `/` input. Real-time filter by command name, source tag pills, command count header. 200ms slide-up animation.

**FilePathPicker**: Slide-up panel triggered by `@` input. Breadcrumb directory navigation, folder/file icons, click-to-navigate folders, click-to-insert files. Client-side cache via file store Map.

### Task 2: Quote, Settings, Integration

**QuotePreviewBar**: Blue indicator line, source label (Claude/You), truncated text, close button. Positioned above input bar.

**Long-press quoting**: Both UserBubble and AssistantBubble support 500ms long-press to show "Quote" context menu. Dispatches SET_QUOTE to chat store.

**QuotedBlock in UserBubble**: Semi-transparent white background, blue vertical line, source prefix, 2-line truncated quote text.

**InputBar upgrade**: Picker mode detection (/ for slash, @ for file), atomic token delete (backspace removes entire command/filepath), quote XML injection on send (`<quote from="...">`), argument hint display.

**Settings menu**: Bottom slide-up panel with bounce animation. Permission mode chips (Default/Auto Accept/Plan), font size A-/A+ controls, PC window toggle (Expand/Shrink via `tt.setWindowSize`). PC toggle only visible when `deviceType === "pc"`.

**Session list DirectoryPicker**: FAB "+" now opens DirectoryPicker modal instead of directly creating session. On directory selection, creates session with `cwd` parameter.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Extracted path-utils.ts for testability**
- **Found during:** Task 1 TDD RED phase
- **Issue:** Importing from directory-picker/index.tsx in tests pulls in React and Taro dependencies which are unavailable in the worktree test environment
- **Fix:** Extracted pure path functions into `path-utils.ts`, re-exported from index.tsx, tests import from path-utils directly
- **Files modified:** path-utils.ts (new), index.tsx (re-export), directory-picker.test.ts (import path)
- **Commit:** c89ddd1

## Decisions Made

1. **Path utils extraction**: Pure path construction functions live in `path-utils.ts` separate from the React component. This keeps them testable without framework dependencies and reusable by FilePathPicker.

## Verification Results

- 7/7 directory-picker path util tests passing
- All new components created with proper CSS and responsive max-width constraints
- Settings menu PC window toggle conditionally rendered based on deviceType

## Self-Check: PASSED

- All 10 created files verified present on disk
- Both commits (c89ddd1, 636e260) verified in git log
- 7/7 directory-picker tests passing
