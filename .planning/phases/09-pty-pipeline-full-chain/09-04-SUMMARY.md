---
phase: 09-pty-pipeline-full-chain
plan: 04
subsystem: web, proxy
tags: [xterm-rendering, fixture-replay, dead-code-cleanup, rotation-fix, snapshot-recovery]
dependency_graph:
  requires:
    - phase: 09-02
      provides: binary-ipc-protocol
    - phase: 09-03
      provides: relay-binary-passthrough
  provides:
    - browser-xterm-rendering
    - fixture-replay-tooling
    - terminal-replay-module
    - event-rotation-fix
  affects: [Phase-10, Phase-11]
tech_stack:
  added: []
  patterns: [snapshot-based-recovery, fixture-replay, fit-content-layout]
key_files:
  created:
    - apps/web/src/lib/terminal-replay.ts
    - apps/web/scripts/convert-fixture.ts
    - apps/proxy/src/tools/inspect-events.ts
    - apps/proxy/src/__tests__/fixtures/pty-recording.bin
  modified:
    - apps/web/src/pages/pty-test.tsx
    - apps/proxy/src/event-store.ts
    - apps/proxy/src/terminal.ts
    - apps/proxy/src/index.ts
    - apps/proxy/src/ipc-protocol.ts
    - apps/proxy/src/pty-manager.ts
    - apps/proxy/src/tap.ts
    - apps/proxy/src/paths.ts
  deleted:
    - apps/proxy/src/replay.ts
    - apps/proxy/src/__tests__/dump-terminal.ts
    - apps/proxy/src/__tests__/fixtures/claude-chunks.ndjson
    - apps/proxy/src/__tests__/fixtures/claude-session.raw
    - apps/proxy/src/__tests__/integration/terminal-e2e.test.ts
decisions:
  - "gzip archival replaced with atomic truncation rotation (rename-based, crash-safe)"
  - "rotation wired into terminal.ts tap callback (was previously never called)"
  - "terminal-replay.ts shared module for snapshot-based recovery (Phase 11 reuse)"
  - "Sarasa Fixed SC required for CJK table alignment in xterm.js"
  - "xterm.js WebGL renderer incompatible with Playwright headless screenshots"
  - "Claude Code clear-screen behavior during resize creates scrollback duplicates (not our bug)"
requirements-completed: [FRONT-07]
metrics:
  files_changed: 20
  lines_added: 372
  lines_deleted: 24176
one_liner: "Browser xterm.js rendering verified, dead code cleanup, rotation fix, snapshot-based replay module"
---

## What was done

1. **Browser xterm.js rendering** (pty-test.tsx): fixture loading via URL param, FitAddon disabled in fixture mode, container width adapts to terminal size, auto-scroll to bottom after replay

2. **Dead code cleanup**: removed replay.ts, serve record/replay/\_\_replay commands, PtyManager.startFromFixture(), old NDJSON fixtures, terminal-e2e.test.ts, dump-terminal.ts, dead IPC message types (pty_terminal_frame, pty_frame_request, pty_scroll_request), unused path constants

3. **Rotation fix**: replaced gzip archival with atomic truncation (write new file via tmp + rename), wired shouldRotate + rotate into terminal.ts tap callback (was never called in production), verified with live session at 500KB threshold

4. **Snapshot-based replay module** (terminal-replay.ts): shared code for applying snapshots and replaying events, findReplayStart locates last snapshot to skip historical duplicates, reusable for Phase 11 client reconnection

5. **Fixture tooling**: inspect-events.ts CLI for CCAE binary validation, convert-fixture.ts for CCAE-to-JSON conversion, CCAE fixture recorded from real terminal session

## Rendering verification results

- ANSI colors, Chinese text, box-drawing table borders render correctly with Sarasa Fixed SC font
- Resize events replay correctly, terminal dimensions track PTY changes
- Scrollback content matches real terminal behavior (including Claude Code's resize-triggered clear-screen duplicates)
- Snapshot-based replay skips to latest snapshot, avoiding full history replay
