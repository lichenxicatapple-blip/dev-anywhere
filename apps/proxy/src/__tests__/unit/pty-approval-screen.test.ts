import { describe, expect, it } from "vitest";
import { hasPtyApprovalPrompt, stripTerminalControls } from "#src/common/pty-approval-screen.js";

describe("PTY approval screen detection", () => {
  it("detects Claude native approval prompt in serialized terminal text", () => {
    expect(
      hasPtyApprovalPrompt(
        `
        Do you want to create hello_world.rs?
        › 1. Yes
          2. Yes, allow all edits in tmp/ during this session (shift+tab)
          3. No
      `,
        "claude",
      ),
    ).toBe(true);
  });

  it("detects Claude approval prompts with status/help lines below the choices", () => {
    expect(
      hasPtyApprovalPrompt(
        `
        match parse_number("abc") {
        }
        Do you want to create hello_world.rs?
        ❯ 1. Yes
          2. Yes, allow all edits during this session (shift+tab)
          3. No

        Esc to cancel · Tab to amend
      `,
        "claude",
      ),
    ).toBe(true);
  });

  it("detects Claude permission OSC text", () => {
    expect(hasPtyApprovalPrompt("Claude needs your permission to use Write", "claude")).toBe(true);
  });

  it("detects Codex-style permission prompts in the visible tail", () => {
    expect(
      hasPtyApprovalPrompt("Would you like to run the following command?\n1. Yes", "codex"),
    ).toBe(true);
    expect(hasPtyApprovalPrompt("Allow Codex to run `cargo test` in /tmp/project", "codex")).toBe(
      true,
    );
  });

  it("ignores normal terminal output", () => {
    expect(hasPtyApprovalPrompt("hello\n$ cargo test\nok", "claude")).toBe(false);
  });

  it("only detects prompts in the visible tail", () => {
    const oldPrompt = [
      "Do you want to create old.rs?",
      "1. Yes",
      "2. Yes, allow all edits in tmp/ during this session",
      "3. No",
      ...Array.from({ length: 20 }, (_, index) => `normal line ${index}`),
    ].join("\n");
    expect(hasPtyApprovalPrompt(oldPrompt, "claude")).toBe(false);
  });

  it("strips ANSI control sequences before matching", () => {
    const text =
      "\x1b[33mDo you want to create file?\x1b[0m\r\n1. Yes\r\n2. Yes, allow all edits in tmp/ during this session\r\n3. No";
    expect(stripTerminalControls(text)).toContain("Do you want");
    expect(hasPtyApprovalPrompt(text, "claude")).toBe(true);
  });
});
