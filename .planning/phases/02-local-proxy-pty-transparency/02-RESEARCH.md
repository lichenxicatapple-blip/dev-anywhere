# Phase 2: Local Proxy - PTY Transparency - Research

**Researched:** 2026-04-03
**Domain:** Terminal PTY wrapping, process lifecycle management, transparent CLI proxy
**Confidence:** HIGH

## Summary

Phase 2 implements the transparent PTY wrapper that makes `cc-anywhere` indistinguishable from running `claude` directly. The scope is narrow and well-defined: spawn Claude Code CLI inside a pseudo-terminal created by node-pty, pipe stdin/stdout byte-for-byte, forward SIGWINCH for window resizing, handle Ctrl+C/Ctrl+D through raw mode stdin, propagate exit codes, and clean up child processes on exit. No remote control, no stream-json integration, no relay -- those are Phase 3+.

The core pattern is straightforward: set the parent terminal to raw mode, spawn `claude` in a node-pty PTY with matching dimensions, pipe `process.stdin` writes to `pty.write()`, pipe `pty.onData` output to `process.stdout.write()`, listen for `process.stdout` `resize` events to call `pty.resize()`, and exit with the child's exit code via `pty.onExit`. The key risks are: (1) UTF-8 multi-byte character corruption at chunk boundaries requires StringDecoder for any string processing path (but the raw byte passthrough for local terminal avoids this), (2) orphaned `claude` processes if the proxy crashes without cleanup, (3) raw mode disabling Ctrl+C at the Node.js level (by design -- it passes through to the PTY as `\x03`), and (4) node-pty requiring native compilation (C++ toolchain must be present).

**Primary recommendation:** Build a minimal, focused PTY wrapper with a noop tap point for future relay integration. Keep the data path zero-copy (Buffer in from PTY, Buffer out to stdout). Use `process.argv.slice(2)` for argument passthrough -- do not use commander for Phase 2 since cc-anywhere consumes zero arguments in this phase. The tap point is a function call on the data path that Phase 3-4 will replace with relay forwarding.

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** `cc-anywhere` as global executable name via package.json `bin` field
- **D-02:** All CLI arguments pass through to `claude` directly; cc-anywhere consumes none of claude's arguments
- **D-03:** cc-anywhere's own config params (e.g. relay address) via environment variables, not CLI args
- **D-04:** Use node-pty to create PTY and spawn claude process
- **D-05:** Exit with same exit code as claude process
- **D-06:** On claude crash, output error to stderr and exit non-zero
- **D-07:** Ensure claude child process is terminated on cc-anywhere exit (no orphans)
- **D-08:** Ctrl+C (SIGINT) and Ctrl+D (EOF) via PTY stdin control characters, not OS signals
- **D-09:** SIGWINCH via node-pty resize() API
- **D-10:** SIGTSTP (Ctrl+Z) passes through PTY normally
- **D-11:** Pure passthrough architecture for Phase 2 -- stdout/stderr from PTY direct to host terminal
- **D-12:** Data flows through a tap point (noop in Phase 2), reserved for Phase 3-4 relay integration, no extra abstraction

### Claude's Discretion
- node-pty specific config params (shell, env passing strategy)
- Error message format

### Deferred Ideas (OUT OF SCOPE)
- Multi-session management -- Phase 3 (PROXY-03)
- stream-json 结构化控制通道 -- Phase 3 (PROXY-02)
- Relay connection and message bridging -- Phase 4 (RELAY-01)
- Terminal and mobile dual-surface sync -- Phase 7 (PROXY-04)

</user_constraints>

<phase_requirements>

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PROXY-01 | Local terminal experience identical to direct `claude` usage (stdin/stdout/stderr passthrough, ANSI escape, interactive prompts) | node-pty provides real PTY allocation with full ANSI support. Raw mode stdin + direct Buffer passthrough ensures byte-for-byte fidelity. SIGWINCH forwarding via resize() maintains layout correctness. |

</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node-pty` | 1.1.0 | PTY allocation and claude process spawning | Microsoft-maintained, used by VS Code terminal. Only Node.js library providing real pseudo-terminal. Verified latest: 1.1.0. |
| Node.js `tty` module | built-in | Raw mode stdin, terminal size detection, resize events | Standard library. `process.stdin.setRawMode(true)` for character-level input. `process.stdout.columns/rows` for initial size. |
| Node.js `string_decoder` | built-in | Safe UTF-8 decoding across chunk boundaries | Standard library. Required if any string processing is done on PTY output (e.g., logging). Not needed for raw Buffer passthrough. |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `commander` | 14.0.3 | CLI argument parsing | NOT used in Phase 2. All args pass through to claude. Will be needed in Phase 3+ when cc-anywhere gets its own subcommands. |
| `strip-ansi` | ^7.2.0 | Strip ANSI escape codes | NOT used in Phase 2. Will be needed for logging/relay in Phase 3+. |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| node-pty | `child_process.spawn` with `stdio: 'inherit'` | No PTY allocation -- loses ANSI support, no tap point for future relay, no resize control. Direct `stdio: 'inherit'` gives transparency but zero extensibility. |
| node-pty | `child_process.spawn` with `stdio: 'pipe'` | Loses PTY semantics entirely. Claude Code detects non-TTY and changes behavior. |
| Raw `process.argv.slice(2)` | commander with `passThroughOptions()` | Commander adds overhead for zero Phase 2 benefit. process.argv.slice(2) is the simplest correct approach. |

**Installation:**
```bash
cd apps/proxy
pnpm add node-pty
```

**Version verification:** `node-pty` latest is 1.1.0 (verified via npm registry 2026-04-03). No `^` needed -- 1.1.0 is the only 1.x release currently available.

**Build prerequisite:** node-pty is a native C++ addon. Requires:
- macOS: Xcode Command Line Tools (`xcode-select --install`)
- Linux: `build-essential`, `python3`
- Windows: Visual Studio Build Tools + Python

**tsup note:** tsup (esbuild) automatically externalizes dependencies listed in package.json. node-pty as a dependency will remain external -- its native `.node` binary is loaded at runtime, not bundled.

## Architecture Patterns

### Recommended Project Structure
```
apps/proxy/
  src/
    index.ts          # CLI entry point: parse env vars, create PTY, wire up I/O
    pty-manager.ts    # PTY lifecycle: spawn, resize, signal forwarding, cleanup
    tap.ts            # Noop data tap (Phase 2), will become relay forwarder in Phase 3-4
  package.json        # bin: { "cc-anywhere": "./dist/index.js" }
  tsup.config.ts
  tsconfig.json
```

### Pattern 1: Transparent PTY Passthrough
**What:** Spawn claude in a PTY, pipe all I/O byte-for-byte between parent terminal and child PTY.
**When to use:** Phase 2 -- the entire phase is this pattern.
**Example:**
```typescript
// Source: node-pty GitHub README + Node.js TTY docs
import * as pty from "node-pty";

// 获取父终端的当前尺寸
const cols = process.stdout.columns ?? 80;
const rows = process.stdout.rows ?? 24;

const child = pty.spawn("claude", process.argv.slice(2), {
  name: process.env.TERM ?? "xterm-256color",
  cols,
  rows,
  cwd: process.cwd(),
  env: process.env as Record<string, string>,
});

// 设置父终端为 raw mode，所有按键直接发送到 PTY
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();

// stdin -> PTY
process.stdin.on("data", (data: Buffer) => {
  child.write(data.toString());
});

// PTY -> stdout (直接写 Buffer，不做任何转换)
child.onData((data: string) => {
  process.stdout.write(data);
});

// SIGWINCH: 窗口大小变化同步到子进程
process.stdout.on("resize", () => {
  child.resize(
    process.stdout.columns ?? 80,
    process.stdout.rows ?? 24
  );
});

// 子进程退出时以相同 exit code 退出
child.onExit(({ exitCode }) => {
  process.stdin.setRawMode(false);
  process.exit(exitCode);
});
```

### Pattern 2: Noop Tap Point for Future Relay
**What:** Data passes through a function that does nothing in Phase 2 but provides the hook for Phase 3-4.
**When to use:** Every byte of PTY output passes through the tap before reaching stdout.
**Example:**
```typescript
// tap.ts -- Phase 2 实现
export type DataTap = (data: string) => void;

// Phase 2: noop，不做任何处理
export const createNoopTap = (): DataTap => {
  return (_data: string) => {
    // Phase 3-4 将在此处注入 relay 转发逻辑
  };
};
```

### Pattern 3: Graceful Process Lifecycle
**What:** Ensure claude child process is always cleaned up, regardless of how the proxy exits.
**When to use:** All exit paths -- normal exit, SIGINT, SIGTERM, SIGHUP, uncaught exception.
**Example:**
```typescript
function cleanup(child: pty.IPty): void {
  try {
    child.kill();
  } catch {
    // 进程可能已经退出
  }
}

// 正常退出已通过 onExit 处理

// 非正常退出：确保子进程被终止
process.on("SIGTERM", () => {
  cleanup(child);
  process.exit(143); // 128 + 15
});

process.on("SIGHUP", () => {
  cleanup(child);
  process.exit(129); // 128 + 1
});

// 注意：SIGINT 在 raw mode 下不会被 Node.js 捕获
// Ctrl+C 作为 \x03 发送到 PTY，由 claude 自行处理
// 如果 claude 因 SIGINT 退出，通过 onExit 回调处理

process.on("uncaughtException", (err) => {
  process.stderr.write(`cc-anywhere: fatal error: ${err.message}\n`);
  cleanup(child);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(
    `cc-anywhere: unhandled rejection: ${reason}\n`
  );
  cleanup(child);
  process.exit(1);
});
```

### Anti-Patterns to Avoid
- **Parsing PTY output as strings for logic decisions:** PTY output is raw terminal data with ANSI escape sequences. Do not parse it, regex it, or make decisions based on content in Phase 2. The tap point receives the data for observation only.
- **Using `child_process.spawn` with `stdio: 'inherit'`:** This gives transparency but no tap point and no programmatic control. Cannot be extended for relay in Phase 3-4.
- **Catching SIGINT in the proxy process:** When stdin is in raw mode, Ctrl+C does not generate SIGINT. It arrives as `\x03` byte and is forwarded to the PTY. Do NOT register a SIGINT handler that tries to do cleanup -- it will never fire during normal interactive use.
- **Using commander to parse args in Phase 2:** Per D-02, all args pass through to claude. commander adds unnecessary complexity. Use `process.argv.slice(2)` directly.
- **Setting `encoding: null` on node-pty:** While this would give raw Buffers on Linux, it has a known bug on Windows (Issue #489) where it still returns strings. Since this project targets macOS primarily and node-pty's default UTF-8 encoding produces strings that `process.stdout.write()` handles correctly, use the default encoding.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| PTY allocation | Fork/exec with manual fd handling | node-pty `spawn()` | PTY setup involves complex Unix system calls (forkpty, openpty). node-pty handles platform differences. |
| Terminal raw mode | Manual termios manipulation | `process.stdin.setRawMode(true)` | Node.js built-in handles all the termios flags correctly. |
| UTF-8 chunk reassembly | Manual byte buffer with lead-byte detection | `StringDecoder` from `string_decoder` | Multi-byte boundary detection is tricky. StringDecoder handles all UTF-8 edge cases. |
| CLI argument parsing | Manual argv parsing | `process.argv.slice(2)` (Phase 2) / `commander` (Phase 3+) | Phase 2 needs zero parsing -- just passthrough. Phase 3+ can add commander when cc-anywhere gets own options. |

**Key insight:** Phase 2 is intentionally minimal. The value is in doing the simple things correctly (raw mode, resize, cleanup) rather than building infrastructure for future phases.

## Common Pitfalls

### Pitfall 1: Orphaned Claude Processes
**What goes wrong:** If cc-anywhere exits abnormally (crash, kill -9, uncaught exception), the claude child process continues running. Users accumulate orphaned processes consuming memory and API quota.
**Why it happens:** node-pty does not auto-kill children when the parent exits. JavaScript `process.on('exit')` handler cannot perform async operations and `pty.kill()` is synchronous, but the exit handler may not fire on SIGKILL.
**How to avoid:** Register cleanup on SIGTERM, SIGHUP, uncaughtException, and unhandledRejection. For the SIGKILL case (unavoidable), document that users should check for orphaned `claude` processes. The `onExit` callback handles normal exit. In Phase 3, a periodic reaper will handle edge cases.
**Warning signs:** `pgrep -f claude` shows unexpected processes. System memory grows over time.

### Pitfall 2: SIGWINCH Race During Fast Resize
**What goes wrong:** Rapidly resizing the terminal fires many SIGWINCH events. If each triggers `pty.resize()` immediately, the child process receives a burst of resize signals, causing garbled output as it redraws mid-resize.
**Why it happens:** Terminal emulators fire SIGWINCH on every pixel change during drag resize.
**How to avoid:** Debounce resize events. A 50-100ms debounce window collapses rapid resizes into one final resize call.
**Warning signs:** Garbled terminal output during window resizing, especially with Claude Code's Ink renderer.

### Pitfall 3: Raw Mode Not Restored on Exit
**What goes wrong:** If the process exits without calling `setRawMode(false)`, the user's terminal remains in raw mode. Keyboard input appears broken (no line editing, no echo, Ctrl+C does nothing).
**Why it happens:** `process.exit()` bypasses normal cleanup. If `setRawMode(false)` is only in the onExit callback but an exception happens before it, the terminal is left broken.
**How to avoid:** Use a single cleanup function called from ALL exit paths. Always call `process.stdin.setRawMode(false)` before `process.exit()`. Consider `process.on('exit')` as a last-resort safety net (it fires synchronously on exit).
**Warning signs:** After cc-anywhere exits, the terminal behaves strangely. User needs to type `reset` to fix it.

### Pitfall 4: node-pty Build Failure on User Machines
**What goes wrong:** `pnpm install` fails because node-pty's native C++ addon cannot compile. Missing Xcode tools on macOS, missing build-essential on Linux, wrong Python version.
**Why it happens:** node-pty uses node-gyp which requires a C++ toolchain. Many developers don't have these installed.
**How to avoid:** Document prerequisites in README. Consider `node-pty-prebuilt-multiarch` as an alternative that ships prebuilt binaries. For development, verify build works in CI on all target platforms.
**Warning signs:** `gyp ERR!` in install output.

### Pitfall 5: Exit Code Discrepancy with Signals
**What goes wrong:** When claude is killed by a signal (e.g., SIGINT), node-pty reports exitCode as 0 instead of null, and signal as the numeric signal value. This differs from child_process behavior where exitCode is null and signal is the signal name.
**Why it happens:** Known node-pty issue (#461). node-pty conflates signal-terminated exits with normal exits.
**How to avoid:** In the onExit callback, check both exitCode and signal. If signal is non-zero, compute the conventional exit code as `128 + signal` (e.g., SIGINT = 2, so exit code = 130). If exitCode is 0 and signal is non-zero, use the signal-based exit code.
**Warning signs:** `cc-anywhere` always exits with 0 even when claude was interrupted.

### Pitfall 6: stdin Not a TTY (Piped Input)
**What goes wrong:** If cc-anywhere is invoked with piped stdin (e.g., `echo "hello" | cc-anywhere`), `process.stdin.isTTY` is false and `setRawMode` will throw.
**Why it happens:** setRawMode only works on TTY streams.
**How to avoid:** Guard `setRawMode` behind `process.stdin.isTTY` check. When stdin is not a TTY, still pipe data to the PTY but skip raw mode. This preserves scripted/piped usage.
**Warning signs:** `TypeError: process.stdin.setRawMode is not a function` when piping input.

## Code Examples

### Complete Minimal PTY Wrapper
```typescript
// Source: node-pty docs + Node.js TTY docs + PITFALLS.md
import * as pty from "node-pty";
import type { IPty } from "node-pty";

interface ProxyOptions {
  claudeArgs: string[];
  onData?: (data: string) => void; // tap point
}

function createProxy(options: ProxyOptions): void {
  const { claudeArgs, onData } = options;

  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;

  const child: IPty = pty.spawn("claude", claudeArgs, {
    name: process.env.TERM ?? "xterm-256color",
    cols,
    rows,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  });

  // 设置 raw mode
  const isInteractive = process.stdin.isTTY === true;
  if (isInteractive) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  // stdin -> PTY
  process.stdin.on("data", (data: Buffer) => {
    child.write(data.toString());
  });

  // PTY -> stdout + tap
  child.onData((data: string) => {
    process.stdout.write(data);
    onData?.(data);
  });

  // resize 防抖
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  process.stdout.on("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      child.resize(
        process.stdout.columns ?? 80,
        process.stdout.rows ?? 24,
      );
    }, 50);
  });

  // 统一清理函数
  const cleanup = (exitCode: number): void => {
    if (isInteractive) {
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    }
    try { child.kill(); } catch { /* 进程可能已退出 */ }
    process.exit(exitCode);
  };

  // 子进程正常退出
  child.onExit(({ exitCode, signal }) => {
    if (isInteractive) {
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    }
    // node-pty 在信号终止时报告 exitCode=0, signal=N
    // 按 Unix 惯例使用 128+signal 作为退出码
    const code = signal ? 128 + signal : exitCode;
    process.exit(code);
  });

  // 信号处理
  process.on("SIGTERM", () => cleanup(143));
  process.on("SIGHUP", () => cleanup(129));

  // 异常处理
  process.on("uncaughtException", (err) => {
    process.stderr.write(
      `cc-anywhere: fatal error: ${err.message}\n`,
    );
    cleanup(1);
  });

  process.on("unhandledRejection", (reason) => {
    process.stderr.write(
      `cc-anywhere: unhandled rejection: ${reason}\n`,
    );
    cleanup(1);
  });

  // stdin 结束时（Ctrl+D 在非 raw 模式，或管道输入结束）
  process.stdin.on("end", () => {
    // 写入 EOF 到 PTY
    child.write("\x04");
  });
}

// 入口
createProxy({
  claudeArgs: process.argv.slice(2),
});
```

### package.json bin Configuration
```json
{
  "name": "@cc-anywhere/proxy",
  "bin": {
    "cc-anywhere": "./dist/index.js"
  },
  "dependencies": {
    "@cc-anywhere/shared": "workspace:*",
    "node-pty": "^1.1.0"
  }
}
```

### tsup.config.ts for Native Module
```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  // node-pty is in dependencies, tsup auto-externalizes it
  // The shebang is needed for the bin entry point
  banner: {
    js: "#!/usr/bin/env node",
  },
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `child_process.spawn` with `stdio: 'inherit'` | node-pty with full PTY | Always for interactive CLI wrapping | `stdio: 'inherit'` gives zero extensibility. node-pty provides a real PTY with programmatic I/O access. |
| node-pty `on('data')` callback style | node-pty `onData` IEvent style | node-pty 0.10+ | IEvent returns IDisposable for clean unsubscription. |
| Manual termios for raw mode | `process.stdin.setRawMode(true)` | Node.js built-in since early versions | No C binding needed. Built-in handles all terminal modes. |

**Deprecated/outdated:**
- `pty.js` (chjj/pty.js): Unmaintained predecessor to node-pty. Do not use.
- node-pty `encoding: null` for raw Buffer mode: Has Windows bug (#489). Use default UTF-8 encoding with string passthrough.

## Open Questions

1. **node-pty `write()` accepts string, but stdin delivers Buffer**
   - What we know: `process.stdin.on('data')` delivers Buffer. `child.write()` accepts `string | Buffer` per typings but the jsdocs show `string`. `data.toString()` is the documented conversion.
   - What's unclear: Whether raw Buffer write is supported on all platforms.
   - Recommendation: Use `data.toString()` for stdin-to-PTY writes. The UTF-8 encoding of ASCII control characters (\x03, \x04, etc.) is identity, so no data loss.

2. **claude CLI binary location detection**
   - What we know: `claude` is at `/Users/admin/.local/bin/claude` on this machine. node-pty `spawn()` uses PATH resolution like the shell.
   - What's unclear: Whether all users have `claude` in PATH. Some may have installed it differently.
   - Recommendation: Use `"claude"` as the command (PATH resolution). If spawn fails with ENOENT, provide a clear error message suggesting the user verify `claude` is installed and in PATH.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | Yes | v22.16.0 | -- |
| Claude Code CLI | PTY spawn target | Yes | 2.1.91 | -- (hard dependency) |
| Python 3 | node-pty native build | Yes | 3.13.9 | -- |
| Xcode CLI Tools | node-pty native build | Yes | Installed | -- |
| pnpm | Package management | Yes | (via project) | -- |

**Missing dependencies with no fallback:** None.

**Missing dependencies with fallback:** None.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.2 |
| Config file | Root `vitest.config.ts` (workspace mode, `projects: ["packages/*", "apps/*"]`). Proxy app needs its own `vitest.config.ts`. |
| Quick run command | `pnpm vitest run --project proxy` |
| Full suite command | `pnpm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PROXY-01a | PTY spawns claude with correct args | unit (mock node-pty) | `pnpm vitest run apps/proxy -t "spawn"` | No -- Wave 0 |
| PROXY-01b | stdin data forwarded to PTY write | unit (mock node-pty) | `pnpm vitest run apps/proxy -t "stdin"` | No -- Wave 0 |
| PROXY-01c | PTY output forwarded to stdout | unit (mock node-pty) | `pnpm vitest run apps/proxy -t "stdout"` | No -- Wave 0 |
| PROXY-01d | SIGWINCH triggers pty.resize with correct dimensions | unit (mock node-pty) | `pnpm vitest run apps/proxy -t "resize"` | No -- Wave 0 |
| PROXY-01e | Exit code propagated from child to parent | unit (mock node-pty) | `pnpm vitest run apps/proxy -t "exit"` | No -- Wave 0 |
| PROXY-01f | Signal-based exit computes 128+signal | unit (mock node-pty) | `pnpm vitest run apps/proxy -t "signal"` | No -- Wave 0 |
| PROXY-01g | Cleanup kills child on SIGTERM | unit (mock node-pty) | `pnpm vitest run apps/proxy -t "cleanup"` | No -- Wave 0 |
| PROXY-01h | Non-TTY stdin handled without setRawMode | unit (mock node-pty) | `pnpm vitest run apps/proxy -t "non-tty"` | No -- Wave 0 |
| PROXY-01i | Transparent terminal behavior (manual) | manual | Run `cc-anywhere` side by side with `claude`, compare ANSI output, resize behavior, Ctrl+C handling | -- |

### Sampling Rate
- **Per task commit:** `pnpm vitest run apps/proxy`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green + manual PROXY-01i verification before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `apps/proxy/vitest.config.ts` -- vitest project config for proxy app
- [ ] `apps/proxy/src/__tests__/pty-manager.test.ts` -- unit tests with mocked node-pty
- [ ] node-pty mock strategy: vi.mock("node-pty") with mock IPty implementing onData, onExit, write, resize, kill

## Project Constraints (from CLAUDE.md)

- Code logs in English
- Comments and docstrings in Chinese
- No emoji in code
- No lazy imports unless circular dependency exists
- Use `rmtrash` instead of `rm`
- git commit messages: concise, one-line, no Co-Authored-By / test counts
- Direct refactoring, no backward-compat adapter layers
- Reuse existing project code/patterns
- No hardcoded directory paths
- No silent fallback -- errors must be thrown explicitly
- ESM + TypeScript (`"type": "module"`) established pattern
- tsup for bundling, vitest for testing
- Zod 4 (not 3) per Phase 1 decision
- TypeScript ^5.8 per Phase 1 decision
- App packages (like proxy) disable DTS output since they are deployable binaries

## Sources

### Primary (HIGH confidence)
- [node-pty GitHub](https://github.com/microsoft/node-pty) -- API docs, spawn/onData/onExit/resize/kill methods, IPty interface
- [node-pty jsdocs.io](https://www.jsdocs.io/package/node-pty) -- Complete TypeScript type definitions
- [Node.js TTY module](https://nodejs.org/api/tty.html) -- setRawMode, columns/rows, resize event, isTTY
- [Node.js string_decoder](https://nodejs.org/api/string_decoder.html) -- UTF-8 chunk boundary handling
- [node-pty Issue #461](https://github.com/microsoft/node-pty/issues/461) -- Exit code discrepancy with signals (exitCode=0 when killed by signal)
- [node-pty Issue #489](https://github.com/microsoft/node-pty/issues/489) -- encoding:null returns string on Windows

### Secondary (MEDIUM confidence)
- [Node.js Process docs](https://nodejs.org/api/process.html) -- Signal handling, process.exit, uncaughtException
- [node-pty-prebuilt-multiarch](https://github.com/homebridge/node-pty-prebuilt-multiarch) -- Prebuilt binary alternative for distribution
- [PITFALLS.md research](../.planning/research/PITFALLS.md) -- Pitfall 2 (UTF-8 corruption), Pitfall 3 (orphaned processes), Pitfall 8 (transparent proxy breakage)

### Tertiary (LOW confidence)
- None. Phase 2 scope is narrow and well-documented.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- node-pty is the only viable option, well-documented, Microsoft-maintained
- Architecture: HIGH -- transparent PTY wrapper is a well-understood pattern with minimal ambiguity
- Pitfalls: HIGH -- all pitfalls documented with specific node-pty issue references and concrete mitigation strategies

**Research date:** 2026-04-03
**Valid until:** 2026-05-03 (stable domain, node-pty 1.1.0 is unlikely to change rapidly)
