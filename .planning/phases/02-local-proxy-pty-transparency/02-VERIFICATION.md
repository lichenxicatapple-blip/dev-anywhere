---
phase: 02-local-proxy-pty-transparency
verified: 2026-04-03T12:58:20Z
status: human_needed
score: 7/7 must-haves verified (automated)
human_verification:
  - test: "Run cc-anywhere --version and compare with claude --version"
    expected: "Identical output"
    why_human: "Requires real terminal with node-pty PTY allocation (blocked in sandboxed environments)"
  - test: "Run cc-anywhere interactively and compare ANSI colors, cursor movement, interactive prompts with direct claude"
    expected: "Visually identical rendering"
    why_human: "ANSI rendering fidelity can only be assessed visually in a real terminal"
  - test: "Resize terminal window while cc-anywhere is running"
    expected: "Output reflows correctly, same as direct claude"
    why_human: "SIGWINCH propagation requires real terminal resize event"
  - test: "Press Ctrl+C during a running task in cc-anywhere"
    expected: "Interrupts the current operation identically to direct claude"
    why_human: "Signal behavior requires real terminal with raw mode PTY"
  - test: "Exit cc-anywhere with /exit or Ctrl+D, then check for orphaned claude processes"
    expected: "No orphaned claude processes remain"
    why_human: "Process cleanup verification requires real process tree inspection"
  - test: "Check exit code propagation: cc-anywhere --version (exit 0), cc-anywhere --nonexistent-flag (non-zero)"
    expected: "Exit codes match what claude itself returns"
    why_human: "Requires real claude binary execution"
---

# Phase 2: Local Proxy - PTY Transparency Verification Report

**Phase Goal:** Users can run `cc-anywhere` instead of `claude` with zero observable difference in terminal behavior
**Verified:** 2026-04-03T12:58:20Z
**Status:** human_needed
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | User runs cc-anywhere and sees identical terminal output to running claude directly (ANSI colors, cursor movement, interactive prompts all preserved) | VERIFIED (code) / ? (visual) | PtyManager uses raw mode stdin + direct stdout.write passthrough with no transformation. PTY spawns with caller's TERM env. All 8 unit tests pass with mocked node-pty. Visual verification requires human. |
| 2 | Terminal resize (SIGWINCH) propagates correctly -- resizing the window mid-session adjusts Claude Code's output layout | VERIFIED (code) / ? (runtime) | stdout "resize" event handler with 50ms debounce calls child.resize() with current columns/rows. Unit test "debounces resize events" confirms 3 rapid resizes collapse to 1 call with final dimensions. Runtime verification requires human. |
| 3 | Ctrl+C, Ctrl+D, and other signal keys behave identically to native Claude Code | VERIFIED (code) / ? (runtime) | Raw mode stdin pipes all bytes directly to PTY (Ctrl+C as \x03 passes through). stdin "end" event writes \x04 (Ctrl+D/EOF) to PTY. SIGTERM/SIGHUP handlers call cleanup(). Unit tests verify stdin-to-PTY forwarding and non-TTY handling. Runtime verification requires human. |
| 4 | Exiting cc-anywhere cleanly terminates the underlying claude process with no orphans | VERIFIED (code) / ? (runtime) | cleanup() calls child.kill() then process.exit(). onExit handler restores raw mode and exits with child's exit code. Signal handlers (SIGTERM, SIGHUP) and error handlers (uncaughtException, unhandledRejection) all route to cleanup(). Unit test "cleanup kills child and restores raw mode" confirms. No-orphan guarantee requires human verification in a real process tree. |
| 5 | PtyManager spawns claude with caller-provided args inside a real PTY | VERIFIED | pty.spawn("claude", this.claudeArgs, ...) at line 30 with cols/rows from stdout. Unit test confirms spawn called with "claude", ["--help"], {cols: 120, rows: 40}. |
| 6 | PTY output passes through data tap function | VERIFIED | child.onData callback calls both this.stdout.write(data) and this.tap(data) at lines 53-54. Unit test "forwards pty output to stdout and tap" confirms both outputs. |
| 7 | Exit code (including signal-based 128+N) propagates correctly | VERIFIED | `const code = signal ? 128 + signal : exitCode` at line 75. Unit tests verify exitCode 42 passes through and signal 2 yields 130 (128+2). |

**Score:** 7/7 truths verified at code level. 4/7 need human runtime verification.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/proxy/src/pty-manager.ts` | PTY lifecycle management: spawn, I/O piping, resize, cleanup | VERIFIED | 116 lines. Exports PtyManager class and PtyManagerOptions interface. Contains pty.spawn, setRawMode, resize debounce, 128+signal, cleanup with kill, SIGTERM/SIGHUP/uncaughtException/unhandledRejection handlers. |
| `apps/proxy/src/tap.ts` | Noop data tap for future relay integration | VERIFIED | 6 lines. Exports DataTap type and createNoopTap function. Intentional noop body -- extension point for Phase 3-4. |
| `apps/proxy/src/__tests__/pty-manager.test.ts` | Unit tests with mocked node-pty covering all PTY behaviors | VERIFIED | 242 lines (>100 minimum). 8 test cases all passing. Covers: spawn args, stdin forwarding, stdout+tap output, resize debounce, exit code propagation, signal exit codes (128+N), cleanup behavior, non-TTY stdin. |
| `apps/proxy/vitest.config.ts` | Vitest project config for proxy app | VERIFIED | 13 lines. Uses __dirname for correct workspace root resolution. Named "proxy" for --project flag. |
| `apps/proxy/tsup.config.ts` | Build config with shebang banner | VERIFIED | Contains `banner: { js: "#!/usr/bin/env node" }`. Build output dist/index.js confirmed starts with shebang. |
| `apps/proxy/src/index.ts` | CLI entry point wiring PtyManager with process.stdin/stdout and noopTap | VERIFIED | 14 lines (>10 minimum). Imports PtyManager and createNoopTap. Uses process.argv.slice(2) for arg passthrough. No commander dependency. |
| `apps/proxy/package.json` | bin field mapping cc-anywhere to dist/index.js | VERIFIED | Contains `"bin": {"cc-anywhere": "./dist/index.js"}`. Has node-pty ^1.1.0 dependency. Has @types/node devDependency. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `apps/proxy/src/pty-manager.ts` | `node-pty` | `pty.spawn()` call | WIRED | Line 30: `pty.spawn("claude", this.claudeArgs, {...})` |
| `apps/proxy/src/pty-manager.ts` | `apps/proxy/src/tap.ts` | `DataTap` callback invocation | WIRED | Line 3: imports DataTap type. Lines 7, 15: stored as option/field. Line 54: `this.tap(data)` called on every PTY output chunk. |
| `apps/proxy/src/index.ts` | `apps/proxy/src/pty-manager.ts` | `new PtyManager()` and `start()` | WIRED | Line 1: import PtyManager. Line 7: new PtyManager({...}). Line 14: manager.start(). |
| `apps/proxy/src/index.ts` | `apps/proxy/src/tap.ts` | `createNoopTap()` call | WIRED | Line 2: import createNoopTap. Line 9: tap: createNoopTap(). |
| `apps/proxy/package.json` | `apps/proxy/dist/index.js` | bin field | WIRED | `"cc-anywhere": "./dist/index.js"` confirmed. dist/index.js exists (2.42 KB) with shebang. Full PtyManager logic bundled in dist output. |

### Data-Flow Trace (Level 4)

Not applicable -- this phase produces a CLI wrapper, not a data-rendering component. The data flow is stdin -> PTY -> stdout, verified through code structure and unit tests.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| TypeScript compiles cleanly | `pnpm --filter @cc-anywhere/proxy typecheck` | Exit 0, no errors | PASS |
| All 8 unit tests pass | `pnpm vitest run --project proxy` | 8 passed, 0 failed, 137ms | PASS |
| Build produces output with shebang | `pnpm --filter @cc-anywhere/proxy build` | dist/index.js (2.42 KB), first line is `#!/usr/bin/env node` | PASS |
| Built bundle contains full PtyManager logic | grep for pty.spawn, setRawMode, resize, 128+signal in dist/index.js | All patterns found in bundled output | PASS |
| cc-anywhere launches claude transparently | `npx cc-anywhere --version` | SKIP -- node-pty posix_spawnp blocked in sandbox | SKIP |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| PROXY-01 | 02-01, 02-02 | cc_anywhere 启动 claude 进程，本地终端体验与直接使用 claude 完全一致（stdin/stdout/stderr 透传、ANSI 转义、交互提示） | SATISFIED (code) / ? (runtime) | PtyManager implements transparent PTY passthrough with raw mode stdin, direct stdout.write, no ANSI transformation. All unit tests pass. Runtime verification requires human testing. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `apps/proxy/src/tap.ts` | 5 | `=> {}` empty function body | Info | Intentional noop by design. Phase 3-4 will inject relay forwarding logic via DataTap interface. Not a stub. |

### Human Verification Required

### 1. Basic Launch and Output Fidelity

**Test:** Run `cd /Users/admin/workspace/cc_anywhere && npx cc-anywhere --version` and compare with `claude --version`
**Expected:** Same version output
**Why human:** node-pty's posix_spawnp is blocked in sandboxed environments. Requires a standard terminal session.

### 2. Interactive Session with ANSI Colors

**Test:** Run `npx cc-anywhere` in one terminal tab and `claude` directly in another. Compare visual rendering: colors, prompts, Ink renderer output.
**Expected:** Visually identical rendering
**Why human:** ANSI color fidelity and cursor movement can only be assessed visually in a real terminal.

### 3. Terminal Resize

**Test:** While cc-anywhere is running, resize the terminal window by dragging.
**Expected:** Output reflows correctly, same as direct claude.
**Why human:** SIGWINCH propagation and visual reflow require a real terminal resize event.

### 4. Ctrl+C Handling

**Test:** While cc-anywhere is running a task, press Ctrl+C.
**Expected:** Interrupts the current operation, same as direct claude.
**Why human:** Signal behavior requires real terminal with raw mode PTY allocation.

### 5. Exit and Process Cleanup

**Test:** Type `/exit` or press Ctrl+D to exit cc-anywhere, then run `pgrep -f "claude" | head -5` to check for orphaned processes.
**Expected:** No orphaned claude processes remain.
**Why human:** Process tree cleanup verification requires real process lifecycle.

### 6. Exit Code Propagation

**Test:** Run `npx cc-anywhere --version; echo "Exit code: $?"` (expect 0) and `npx cc-anywhere --nonexistent-flag; echo "Exit code: $?"` (expect non-zero matching claude's exit code).
**Expected:** Exit codes match what claude itself returns.
**Why human:** Requires real claude binary execution.

### Gaps Summary

No code-level gaps found. All artifacts exist, are substantive (not stubs), and are properly wired together. TypeScript compiles, all 8 unit tests pass, build produces correct output with shebang.

The sole outstanding item is human runtime verification. The implementation is architecturally correct -- raw mode PTY passthrough with no data transformation is the standard approach for transparent terminal wrapping. However, real-world ANSI rendering, resize behavior, and process lifecycle can only be confirmed by running `cc-anywhere` in a real terminal session (which requires node-pty's PTY allocation to succeed, blocked in sandboxed environments).

---

_Verified: 2026-04-03T12:58:20Z_
_Verifier: Claude (gsd-verifier)_
