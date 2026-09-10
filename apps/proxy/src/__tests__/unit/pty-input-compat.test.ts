import { describe, expect, it } from "vitest";
import { createPtyInputCompat } from "#src/common/pty-input-compat.js";

const win32ShiftEnter = "\x1b[13;28;13;1;16;1_";
const win32Escape = "\x1b[27;1;27;1;0;1_\x1b[27;1;27;0;0;1_";

describe("PTY input compatibility", () => {
  it("uses Alt+Enter for an isolated Windows Codex LF without enabling Win32 input", () => {
    const compat = createPtyInputCompat("codex", "win32");
    expect(compat.encodeRemote("\x1b")).toBe("\x1b");
    expect(compat.encodeRemote("\n")).toBe("\x1b\r");
    expect(compat.encodeRemote("\x1b")).toBe("\x1b");
  });

  it("encodes Escape after a complete native Win32 record", () => {
    const compat = createPtyInputCompat("codex", "win32");
    compat.observe(win32ShiftEnter);
    expect(compat.encodeRemote("\x1b")).toBe(win32Escape);
    expect(compat.encodeRemote("a")).toBe("a");
  });

  it("recognizes Win32 records across every possible chunk boundary", () => {
    for (let split = 1; split < win32ShiftEnter.length; split++) {
      const compat = createPtyInputCompat("codex", "win32");
      compat.observe("x".repeat(256) + win32ShiftEnter.slice(0, split));
      compat.observe(win32ShiftEnter.slice(split));
      expect(compat.encodeRemote("\x1b")).toBe(win32Escape);
    }
  });

  it("also observes native records received through the remote path", () => {
    const compat = createPtyInputCompat(undefined, "win32");
    expect(compat.encodeRemote(win32ShiftEnter)).toBe(win32ShiftEnter);
    expect(compat.encodeRemote("\x1b")).toBe(win32Escape);
  });

  it.each(["claude", "kimi", undefined] as const)(
    "keeps LF semantics for provider %s while repairing existing Win32 Escape input",
    (provider) => {
      const compat = createPtyInputCompat(provider, "win32");
      expect(compat.encodeRemote("\n")).toBe("\n");
      compat.observe(win32ShiftEnter);
      expect(compat.encodeRemote("\x1b")).toBe(win32Escape);
    },
  );

  it.each(["linux", "darwin"] as const)("preserves all input on %s", (platform) => {
    const compat = createPtyInputCompat("codex", platform);
    compat.observe(win32ShiftEnter);
    for (const data of ["\n", "\x1b", win32ShiftEnter, "hello\nworld", "\x1b[A"]) {
      expect(compat.encodeRemote(data)).toBe(data);
    }
  });

  it("preserves complete pastes, ordinary text and other escape sequences", () => {
    const compat = createPtyInputCompat("codex", "win32");
    compat.observe(win32ShiftEnter);
    for (const data of [
      "hello",
      "one\ntwo\n",
      "\n\n",
      "\r",
      "\x1b[A",
      "\x1b\r",
      "\x1b[13;2u",
      "\x1b[200~one\n\x1btwo\x1b[201~",
    ]) {
      expect(compat.encodeRemote(data)).toBe(data);
    }
  });

  it("does not rewrite isolated control characters inside a split bracketed paste", () => {
    const compat = createPtyInputCompat("codex", "win32");
    compat.observe(win32ShiftEnter);
    for (const data of ["\x1b[20", "0~text", "\n", "\x1b", "text", "\x1b[201", "~"]) {
      expect(compat.encodeRemote(data)).toBe(data);
    }
    expect(compat.encodeRemote("\n")).toBe("\x1b\r");
    expect(compat.encodeRemote("\x1b")).toBe(win32Escape);
  });

  it("does not enter Win32 input mode from records embedded in bracketed paste", () => {
    const compat = createPtyInputCompat("codex", "win32");
    compat.observe("\x1b[200~");
    compat.observe(win32ShiftEnter);
    compat.observe("\x1b[201~");
    expect(compat.encodeRemote("\x1b")).toBe("\x1b");
  });

  it("does not enter Win32 input mode from incomplete or unrelated sequences", () => {
    for (const data of ["\x1b[13;28;13;1;16;1", "\x1b[13;2u", "\x1b[?9001h"]) {
      const compat = createPtyInputCompat("codex", "win32");
      compat.observe(data);
      expect(compat.encodeRemote("\x1b")).toBe("\x1b");
    }
  });
});
