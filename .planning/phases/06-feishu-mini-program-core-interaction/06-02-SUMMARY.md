---
phase: 06-feishu-mini-program-core-interaction
plan: 02
subsystem: proxy
tags: [xterm, terminal-grid, osc, pty-state, ansi-256]

requires:
  - phase: 03-service-client-architecture
    provides: TerminalTracker with xterm headless buffer
provides:
  - extractGrid() method returning styled TermLine[] from xterm buffer
  - hasGridChanged() hash-based grid change detection
  - OSC semantic signal extractor (turn_complete, approval_wait, mid_pause)
  - TermSpan/TermLine types for terminal text grid
  - PtySemanticState/PtyStateEvent types for PTY state classification
affects: [06-07-pty-frame-push, 06-08-pty-state-overlay]

tech-stack:
  added: []
  patterns: [xterm buffer getLine/getCell extraction, ANSI 256-color palette mapping, OSC sequence regex parsing]

key-files:
  created:
    - apps/proxy/src/osc-extractor.ts
    - apps/proxy/src/__tests__/terminal-grid.test.ts
    - apps/proxy/src/__tests__/osc-extractor.test.ts
  modified:
    - apps/proxy/src/terminal-tracker.ts

key-decisions:
  - "ANSI 256 palette computed programmatically (6x6x6 RGB cube + 24 grayscale) rather than hardcoded lookup table"
  - "Grid change detection uses MD5 hash of JSON-serialized grid for cheap comparison"
  - "OSC regex creates new instance per call to avoid g-flag lastIndex state leakage"

patterns-established:
  - "cellColorToHex pattern: check default -> RGB -> palette in sequence for IBufferCell color extraction"
  - "Span merging: adjacent cells with identical (fg, bg, bold) collapsed into single TermSpan"

requirements-completed: [FEISHU-01]

duration: 3min
completed: 2026-04-08
---

# Phase 6 Plan 02: Terminal Grid Extraction & OSC Signal Extractor Summary

**xterm buffer grid extraction with 256-color support and OSC 0/9 semantic state classifier for PTY remote viewing**

## Performance

- **Duration:** 3 min
- **Started:** 2026-04-08T11:54:14Z
- **Completed:** 2026-04-08T11:57:12Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- TerminalTracker.extractGrid() converts xterm headless buffer into styled TermLine[] arrays with fg/bg/bold span merging
- ANSI 256-color palette support (standard 16 + 216 RGB cube + 24 grayscale) via computed lookup table
- OSC extractor classifies PTY semantic signals: turn_complete, approval_wait (with tool name), mid_pause
- hasGridChanged() provides hash-based change detection for efficient frame pushing
- 18 total tests (9 grid + 9 OSC) all passing

## Task Commits

Each task was committed atomically:

1. **Task 1: Add extractGrid() method to TerminalTracker** - `68f5b87` (test: RED), `91ab112` (feat: GREEN)
2. **Task 2: Create OSC semantic signal extractor** - `8699972` (test: RED), `8a93f6e` (feat: GREEN)

_TDD tasks have two commits each (test then feat)_

## Files Created/Modified
- `apps/proxy/src/terminal-tracker.ts` - Added extractGrid(), hasGridChanged(), cellColorToHex(), ANSI_256_COLORS palette, TermSpan/TermLine types
- `apps/proxy/src/osc-extractor.ts` - New module: extractOscSignals() parsing OSC 0/9 with PtySemanticState/PtyStateEvent types
- `apps/proxy/src/__tests__/terminal-grid.test.ts` - 9 tests: plain text, style merging, fg/bg color, bold, wide chars, change detection
- `apps/proxy/src/__tests__/osc-extractor.test.ts` - 9 tests: turn_complete, approval_wait, tool extraction, mid_pause, BEL/ST terminators, priority

## Decisions Made
- ANSI 256 palette computed programmatically rather than storing a 256-entry string literal -- cleaner and verifiable
- Grid change detection uses MD5 hash of JSON.stringify(grid) -- cheap enough for frame-rate detection, no external dependency
- OSC regex instantiated fresh per extractOscSignals() call to prevent g-flag lastIndex pollution between calls
- TermSpan/TermLine types defined locally in proxy (not imported from shared) to avoid circular timing dependency with Plan 01

## Deviations from Plan

None -- plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None -- no external service configuration required.

## Next Phase Readiness
- extractGrid() ready for Plan 07 (PTY frame push) to send terminal frames to relay
- OSC extractor ready for Plan 08 (PTY state overlay) to classify session state on mini program
- TermSpan/TermLine types available for import by other proxy modules

## Self-Check: PASSED

- [x] apps/proxy/src/terminal-tracker.ts -- FOUND
- [x] apps/proxy/src/osc-extractor.ts -- FOUND
- [x] apps/proxy/src/__tests__/terminal-grid.test.ts -- FOUND
- [x] apps/proxy/src/__tests__/osc-extractor.test.ts -- FOUND
- [x] Commit 68f5b87 -- FOUND
- [x] Commit 91ab112 -- FOUND
- [x] Commit 8699972 -- FOUND
- [x] Commit 8a93f6e -- FOUND

---
*Phase: 06-feishu-mini-program-core-interaction*
*Completed: 2026-04-08*
