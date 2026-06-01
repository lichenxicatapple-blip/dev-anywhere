import { describe, it, expect } from "vitest";
import {
  appendPtySemanticTextTail,
  extractOscSequences,
  extractOscSignals,
  extractTextSignals,
  normalizePtySemanticText,
} from "#src/common/osc-extractor.js";

describe("extractOscSignals", () => {
  it("extracts OSC sequences in frame order", () => {
    const data = "\x1b]0;old title\x07text\x1b]9;waiting for your input\x07";
    expect(extractOscSequences(data)).toEqual([
      { code: 0, text: "old title" },
      { code: 9, text: "waiting for your input" },
    ]);
  });

  it("returns turn_complete for OSC 9 'waiting for your input'", () => {
    // BEL 结尾
    const data = "\x1b]9;waiting for your input\x07";
    const result = extractOscSignals(data);
    expect(result).toEqual({ state: "turn_complete" });
  });

  it("returns turn_complete for Claude's numeric idle OSC 9 code", () => {
    const data = "\x1b]0;Claude Code\x07\x1b]9;4;0;\x07";
    const result = extractOscSignals(data);
    expect(result).toEqual({ state: "turn_complete", title: "Claude Code" });
  });

  it("returns approval_wait for OSC 9 'needs your permission'", () => {
    const data = "\x1b]9;needs your permission\x07";
    const result = extractOscSignals(data);
    expect(result).not.toBeNull();
    expect(result!.state).toBe("approval_wait");
  });

  it("extracts tool name from 'needs your permission: Bash'", () => {
    const data = "\x1b]9;needs your permission: Bash\x07";
    const result = extractOscSignals(data);
    expect(result).toEqual({ state: "approval_wait", tool: "Bash" });
  });

  it("returns null state with title for OSC 0 only (title-only update)", () => {
    const data = "\x1b]0;claude - working...\x07";
    const result = extractOscSignals(data);
    expect(result).toEqual({ state: null, title: "claude - working..." });
  });

  it("returns approval_wait for Codex action-required OSC title", () => {
    const data = "\x1b]0;[ ! ] Action Required | sample-app\x07";
    const result = extractOscSignals(data, "codex");
    expect(result).toEqual({ state: "approval_wait", title: "[ ! ] Action Required | sample-app" });
  });

  it("does not treat Codex action-required words as state without an OSC title", () => {
    const result = extractOscSignals("[ ! ] Action Required | sample-app", "codex");
    expect(result).toBeNull();
  });

  it("returns null when no OSC sequences present", () => {
    const data = "plain terminal output with no escapes";
    const result = extractOscSignals(data);
    expect(result).toBeNull();
  });

  it("prioritizes OSC 9 over OSC 0 when both present", () => {
    const data = "\x1b]0;some title\x07" + "some output" + "\x1b]9;waiting for your input\x07";
    const result = extractOscSignals(data);
    expect(result).toEqual({ state: "turn_complete", title: "some title" });
  });

  it("uses the last OSC title and notification when a frame contains repeated OSC sequences", () => {
    const data =
      "\x1b]0;stale title\x07" +
      "\x1b]9;needs your permission: Bash\x07" +
      "\x1b]0;fresh title\x07" +
      "\x1b]9;waiting for your input\x07";
    const result = extractOscSignals(data);
    expect(result).toEqual({ state: "turn_complete", title: "fresh title" });
  });

  it("keeps title when OSC 9 reports approval wait", () => {
    const data = "\x1b]0;approval title\x07\x1b]9;needs your permission: Bash\x07";
    const result = extractOscSignals(data);
    expect(result).toEqual({ state: "approval_wait", title: "approval title", tool: "Bash" });
  });

  it("handles BEL terminator (\\x07)", () => {
    const data = "\x1b]9;waiting for your input\x07";
    const result = extractOscSignals(data);
    expect(result).not.toBeNull();
    expect(result!.state).toBe("turn_complete");
  });

  it("handles ST terminator (ESC \\\\)", () => {
    const data = "\x1b]9;waiting for your input\x1b\\";
    const result = extractOscSignals(data);
    expect(result).not.toBeNull();
    expect(result!.state).toBe("turn_complete");
  });

  it("parses correctly with embedded data around OSC sequences", () => {
    const data =
      "some terminal output before\x1b]9;needs your permission: Write\x07more output after";
    const result = extractOscSignals(data);
    expect(result).toEqual({ state: "approval_wait", tool: "Write" });
  });

  it("normalizes ANSI-wrapped PTY text for semantic detection", () => {
    const text = normalizePtySemanticText("\x1b[1mHook PreToolUse:Bash\x1b[0m\r\nDo you want?");

    expect(text).toContain("Hook PreToolUse:Bash");
    expect(text).toContain("Do you want?");
    expect(text).not.toContain("\x1b");
  });

  it("strips title-only OSC while preserving visible terminal output", () => {
    const text = normalizePtySemanticText("\x1b]0;codex\x07Running tests...\r\n");

    expect(text).toBe("Running tests...");
  });

  it("returns approval_wait for Claude hook command confirmation text", () => {
    const text = [
      "Hook PreToolUse:Bash requires confirmation for this command. [settings]",
      "settings.json to update hooks",
      "Do you want to proceed?",
      "1. Yes",
      "2. No",
    ].join("\n");

    const result = extractTextSignals(text, "claude");

    expect(result).toEqual({
      state: "approval_wait",
      tool: "Bash",
      title: "Hook confirmation: Bash",
    });
  });

  it("returns approval_wait for Claude hook tool confirmation text", () => {
    const text = [
      "Hook PreToolUse:WebSearch requires confirmation for this tool. [settings]",
      "settings.json to update hooks",
      "Do you want to proceed?",
      "1. Yes",
      "2. Yes, and don't ask again for Web Search commands in /Users/catli/MyApps/dev-anywhere",
      "3. No",
    ].join("\n");

    const result = extractTextSignals(text, "claude");

    expect(result).toEqual({
      state: "approval_wait",
      tool: "WebSearch",
      title: "Hook confirmation: WebSearch",
    });
  });

  it("returns approval_wait for Claude Code native edit confirmation text", () => {
    const text = [
      "Do you want to make this edit to voice-pilot-status.tsx?",
      "> 1. Yes",
      "  2. Yes, allow all edits during this session (shift+tab)",
      "  3. No",
      "Esc to cancel · Tab to amend",
    ].join("\n");

    const result = extractTextSignals(text, "claude");

    expect(result).toEqual({
      state: "approval_wait",
      tool: "Edit",
      title: "Claude permission: Edit",
    });
  });

  it("detects Claude hook confirmation across PTY chunks", () => {
    let tail = "";
    tail = appendPtySemanticTextTail(
      tail,
      "Hook PreToolUse:Bash requires confirmation for this command.",
    );
    expect(extractTextSignals(tail, "claude")).toBeNull();

    tail = appendPtySemanticTextTail(tail, "\nDo you want to proceed?\n1. Yes\n2. No");

    expect(extractTextSignals(tail, "claude")).toEqual(
      expect.objectContaining({ state: "approval_wait", tool: "Bash" }),
    );
  });

  it("does not treat Claude hook confirmation text as Codex approval", () => {
    const text =
      "Hook PreToolUse:Bash requires confirmation for this command.\nDo you want to proceed?";

    expect(extractTextSignals(text, "codex")).toBeNull();
  });
});
