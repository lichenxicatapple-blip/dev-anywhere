import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PtyRuntime,
  buildHostedPtyArgs,
  normalizePtyEnv,
  type PtyRuntimeEvents,
  type PtyRuntimeOptions,
} from "#src/common/pty-runtime.js";
import type { PtySnapshot } from "#src/common/pty-render-sequencer.js";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("#src/common/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/common/paths.js")>();
  return { ...actual, sessionPaths: (id: string) => actual.buildSessionPaths(fixture.root, id) };
});
const spawnMock = vi.hoisted(() =>
  vi.fn(() => ({
    pid: 2468,
    onData: vi.fn<(callback: (data: string) => void) => void>(),
    onExit: vi.fn<(callback: (event: { exitCode: number; signal: number }) => void) => void>(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
);
vi.mock("node-pty", () => ({ spawn: spawnMock }));
const runtimes: PtyRuntime[] = [];
beforeEach(() => {
  fixture.root = mkdtempSync(join(tmpdir(), "dev-anywhere-pty-runtime-"));
});
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.terminate();
  vi.useRealTimers();
  spawnMock.mockClear();
  rmSync(fixture.root, { recursive: true, force: true });
});

function createRuntime(options: Partial<PtyRuntimeOptions> = {}) {
  const events = {
    output: vi.fn<PtyRuntimeEvents["output"]>(),
    resize: vi.fn<PtyRuntimeEvents["resize"]>(),
    title: vi.fn<PtyRuntimeEvents["title"]>(),
    cwd: vi.fn<PtyRuntimeEvents["cwd"]>(),
    semantic: vi.fn<PtyRuntimeEvents["semantic"]>(),
    exit: vi.fn<PtyRuntimeEvents["exit"]>(),
  };
  const settings = {
    sessionId: "s1",
    kind: "terminal",
    shell: process.execPath,
    cwd: fixture.root,
    cols: 80,
    rows: 24,
    env: {
      ...process.env,
      CLAUDE_BIN: process.execPath,
      CODEX_BIN: process.execPath,
      KIMI_BIN: process.execPath,
    },
    ...options,
  } as PtyRuntimeOptions;
  const runtime = new PtyRuntime(settings, events);
  runtimes.push(runtime);
  const pid = runtime.start();
  const child = spawnMock.mock.results.at(-1)!.value;
  return {
    runtime,
    events,
    pid,
    child,
    data: child.onData.mock.calls[0][0],
    exit: child.onExit.mock.calls[0][0],
  };
}
const snapshot = (runtime: PtyRuntime) =>
  new Promise<PtySnapshot>((resolve) => runtime.snapshot(resolve));

describe("PTY runtime", () => {
  it("builds provider-specific resume args", () => {
    expect(buildHostedPtyArgs("claude", "native")).toEqual(["--resume", "native"]);
    expect(buildHostedPtyArgs("codex", "native")).toEqual(["resume", "native"]);
    expect(buildHostedPtyArgs("kimi", "native")).toEqual(["--session", "native"]);
    expect(buildHostedPtyArgs("claude")).toEqual([]);
  });

  it("normalizes truecolor without dropping unrelated environment", () => {
    const env = normalizePtyEnv({
      TERM: "dumb",
      COLORTERM: "ignored",
      NO_COLOR: "1",
      CLICOLOR: "0",
      KEEP_ME: "yes",
      UNDEFINED_VALUE: undefined,
    });
    expect(env).toMatchObject({
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      CLICOLOR: "1",
      KEEP_ME: "yes",
    });
    expect(env).not.toHaveProperty("NO_COLOR");
    expect(env).not.toHaveProperty("UNDEFINED_VALUE");
  });

  it.each([
    ["claude", "plan", ["--permission-mode", "plan", "--resume", "native"]],
    [
      "codex",
      "bypassPermissions",
      ["--dangerously-bypass-approvals-and-sandbox", "resume", "native"],
    ],
    ["kimi", "auto", ["--yolo", "--session", "native"]],
  ] as const)(
    "preserves %s permission and resume launch settings",
    (provider, permissionMode, expected) => {
      const { pid } = createRuntime({
        kind: "agent",
        provider,
        args: buildHostedPtyArgs(provider, "native"),
        permissionMode,
      });
      expect(pid).toBe(2468);
      expect(spawnMock).toHaveBeenCalledWith(
        process.execPath,
        expect.arrayContaining([...expected]),
        expect.objectContaining({ cwd: fixture.root }),
      );
    },
  );

  it("preserves Claude hook settings in the provider launch", () => {
    createRuntime({
      kind: "agent",
      provider: "claude",
      args: [],
      hook: {
        provider: "claude",
        sessionId: "s1",
        hookUrl: "http://127.0.0.1:1/hook",
        marker: "marker",
        token: "secret",
      },
    });
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(["--settings"]),
      expect.any(Object),
    );
  });

  it("starts a shell without provider args at requested geometry", () => {
    createRuntime({ cols: 125, rows: 34 });
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [],
      expect.objectContaining({ cols: 125, rows: 34, cwd: fixture.root }),
    );
  });

  it("terminates only the owned child once and ignores callbacks after disposal", () => {
    const { runtime, child, events, data, exit } = createRuntime();
    runtime.terminate();
    runtime.terminate();
    data("late");
    exit({ exitCode: 1, signal: 0 });
    expect(child.kill).toHaveBeenCalledOnce();
    expect(events.output).not.toHaveBeenCalled();
    expect(events.exit).not.toHaveBeenCalled();
    expect(() => runtime.start()).toThrow("already");
  });

  it("reports natural exit and structured Codex active-writer facts", () => {
    const nativeSessionId = "019fa141-cdaf-78a2-a6c1-9cca04fb9f9a";
    const { data, exit, events, child } = createRuntime({
      kind: "agent",
      provider: "codex",
      args: [],
      nativeSessionId,
    });
    data("ordinary output".repeat(900));
    data(`\r\nError: thread ${nativeSessionId} already has an active writer (code -32600)\r\n`);
    exit({ exitCode: 1, signal: 0 });
    expect(events.exit).toHaveBeenCalledWith(
      expect.objectContaining({
        exitCode: 1,
        runtimeError: { errorCode: "SESSION_ALREADY_ACTIVE", nativeSessionId },
        errorTail: expect.stringContaining("active writer"),
      }),
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("reports ordinary exit without inventing a conflict", () => {
    const { exit, events } = createRuntime();
    exit({ exitCode: 0, signal: 0 });
    expect(events.exit).toHaveBeenCalledWith({ exitCode: 0 });
  });

  it("flushes final output before semantic completion and exit", () => {
    const { data, exit, events } = createRuntime({ kind: "agent", provider: "kimi", args: [] });
    data("\x1b[?2026hfinal response");
    exit({ exitCode: 0, signal: 0 });
    expect(events.output).toHaveBeenCalledWith("\x1b[?2026hfinal response", 1);
    expect(events.output.mock.invocationCallOrder[0]).toBeLessThan(
      events.semantic.mock.invocationCallOrder[0],
    );
    expect(events.semantic.mock.invocationCallOrder[0]).toBeLessThan(
      events.exit.mock.invocationCallOrder[0],
    );
  });

  it("waits for queued output at the snapshot barrier", async () => {
    const { runtime, data } = createRuntime();
    data("snapshot-sentinel\r\n");
    const result = await snapshot(runtime);
    expect(result).toMatchObject({ cols: 80, rows: 24, outputSeq: 1 });
    expect(result.data).toContain("snapshot-sentinel");
  });

  it("keeps snapshot geometry and watermark when resize follows immediately", async () => {
    const { runtime, data, events } = createRuntime();
    data("before-resize\r\n");
    const beforePending = snapshot(runtime);
    runtime.resize(100, 30);
    data("after-resize\r\n");
    const before = await beforePending;
    expect(before).toMatchObject({ cols: 80, rows: 24, outputSeq: 1 });
    expect(before.data).toContain("before-resize");
    expect(before.data).not.toContain("after-resize");
    expect(events.resize).toHaveBeenCalledWith(100, 30, 2);
    const after = await snapshot(runtime);
    expect(after).toMatchObject({ cols: 100, rows: 30, outputSeq: 3 });
    expect(after.data).toContain("after-resize");
  });

  it("sequences resize between preceding and following bytes", () => {
    const { runtime, data, events, child } = createRuntime();
    data("before");
    runtime.resize(100, 30);
    data("after");
    expect(events.output.mock.calls).toEqual([
      ["before", 1],
      ["after", 3],
    ]);
    expect(events.resize).toHaveBeenCalledWith(100, 30, 2);
    expect(child.resize).toHaveBeenCalledWith(100, 30);
  });

  it("coalesces complete synchronized output and preserves surrounding bytes", () => {
    const { runtime, data, events } = createRuntime();
    data("before");
    data("\x1b[?2026hfirst");
    data("second\x1b[?2026lafter");
    expect(events.output.mock.calls).toEqual([
      ["before", 1],
      ["\x1b[?2026hfirstsecond\x1b[?2026l", 2],
      ["after", 3],
    ]);
    runtime.terminate();
    expect(events.output).toHaveBeenCalledTimes(3);
  });

  it("coalesces a large Kimi redraw split over many chunks", () => {
    const { runtime, data, events } = createRuntime({ kind: "agent", provider: "kimi", args: [] });
    const body = "kimi-history-line\r\n".repeat(19_000);
    const transaction = `\x1b[?2026h\x1b[2J\x1b[H\x1b[3J${body}\x1b[?2026l`;
    for (let offset = 0; offset < transaction.length; offset += 1_013)
      data(transaction.slice(offset, offset + 1_013));
    expect(events.output.mock.calls).toEqual([[transaction, 1]]);
    runtime.terminate();
    expect(events.output).toHaveBeenCalledOnce();
  });

  it("flushes an incomplete transaction exactly once before resize", () => {
    const { runtime, data, events } = createRuntime();
    data("\x1b[?2026hpartial");
    expect(events.output).not.toHaveBeenCalled();
    runtime.resize(100, 30);
    data("after");
    runtime.terminate();
    expect(events.output.mock.calls).toEqual([
      ["\x1b[?2026hpartial", 1],
      ["after", 3],
    ]);
    expect(events.resize).toHaveBeenCalledWith(100, 30, 2);
  });

  it("flushes an incomplete transaction once on termination", () => {
    const { runtime, data, events } = createRuntime();
    data("\x1b[?2026hpartial");
    runtime.terminate();
    runtime.terminate();
    expect(events.output.mock.calls).toEqual([["\x1b[?2026hpartial", 1]]);
  });

  it("routes Codex history transformations through the same sequenced render stream", () => {
    const { runtime, data, events } = createRuntime({
      kind: "agent",
      provider: "codex",
      args: [],
      rows: 24,
    });
    const transaction = "\x1b[?2026h\x1b[1;20r\x1b[2S\x1b[r\x1b[19;1H\x1b[J\x1b[?2026l";
    data(transaction);
    expect(events.output.mock.calls[0]).toEqual([
      "\x1b[?2026h\x1b[r\x1b[999;1H\n\n\x1b[H\x1b[19;1H\x1b[J\x1b[?2026l",
      1,
    ]);
    runtime.resize(80, 20);
    data(transaction);
    expect(events.output.mock.calls[1]).toEqual([transaction, 3]);
  });

  it("reports shell OSC title and cwd without inferring Agent activity", () => {
    const { runtime, data, events } = createRuntime();
    data("\x1b]7;file://host/Users/dev/My%20Project\x1b\\");
    data("\x1b]0;shell title\x07$ echo hi\r\n");
    runtime.write("\r");
    runtime.replaySemanticState();
    expect(events.cwd).toHaveBeenCalledWith("/Users/dev/My Project");
    expect(events.title).toHaveBeenCalledWith("shell title");
    expect(events.semantic).not.toHaveBeenCalled();
  });

  it("keeps semantic sequence monotonic including state replay", () => {
    const { runtime, data, events } = createRuntime({ kind: "agent", provider: "codex", args: [] });
    data("\x1b]9;needs your permission: Bash\x07");
    data("\x1b]9;needs your permission: Write\x07");
    runtime.replaySemanticState();
    expect(events.semantic.mock.calls.map(([state, seq]) => [state, seq])).toEqual([
      ["approval_wait", 1],
      ["approval_wait", 2],
      ["approval_wait", 3],
    ]);
  });

  it("keeps completion latched through redraws and starts on submitted input", () => {
    const { runtime, data, events, child } = createRuntime({
      kind: "agent",
      provider: "codex",
      args: [],
    });
    data("\x1b]0;⠧ dev-anywhere\x07");
    data("agent response\r\n");
    runtime.write("next prompt");
    expect(events.semantic).not.toHaveBeenCalled();
    runtime.write("\r");
    expect(events.semantic.mock.calls).toEqual([["working", 1, undefined]]);
    expect(child.write.mock.calls).toEqual([["next prompt"], ["\r"]]);
  });

  it("preserves approval state through action-required spinner frames", () => {
    const { runtime, data, events } = createRuntime({ kind: "agent", provider: "codex", args: [] });
    runtime.setApprovalWaiting(true);
    data("\x1b]0;[ ! ] Action Required | sample-app\x07");
    data("\x1b]0;[ . ] Action Required | sample-app\x07");
    expect(events.semantic.mock.calls.map(([state]) => state)).toEqual([
      "approval_wait",
      "approval_wait",
    ]);
  });

  it("recognizes chunked text approval and releases it only on an answer", () => {
    const { runtime, data, events } = createRuntime({
      kind: "agent",
      provider: "claude",
      args: [],
    });
    data("Hook PreToolUse:Bash requires confirmation for this command.");
    data("\nDo you want to proceed?\n1. Yes\n2. No");
    data("\x1b]0;ordinary spinner\x07");
    expect(events.semantic.mock.calls.every(([state]) => state === "approval_wait")).toBe(true);
    runtime.write("y");
    expect(events.semantic.mock.calls.at(-1)?.[0]).toBe("working");
  });

  it("completes idle working turns but does not clear pending hook approval", () => {
    vi.useFakeTimers();
    const { runtime, data, events } = createRuntime({ kind: "agent", provider: "kimi", args: [] });
    runtime.write("\r");
    data("response");
    runtime.setApprovalWaiting(true);
    vi.advanceTimersByTime(6_100);
    expect(events.semantic.mock.calls.map(([state]) => state)).toEqual(["working"]);
    runtime.setApprovalWaiting(false);
    data("continued response");
    vi.advanceTimersByTime(6_100);
    expect(events.semantic.mock.calls.map(([state]) => state)).toEqual([
      "working",
      "turn_complete",
    ]);
  });
});
