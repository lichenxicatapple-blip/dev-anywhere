import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURSOR_PROVIDER,
  CursorJsonUnsupportedError,
  CursorPermissionModeUnsupportedError,
  resolveCursorCommand,
} from "#src/providers/cursor.js";

function withExecutable(name: string, test: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "dev-anywhere-cursor-provider-"));
  try {
    const path = join(dir, name);
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o755);
    test(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Cursor provider", () => {
  it("uses CURSOR_BIN before probing PATH", () => {
    withExecutable("agent", (cursorBin) => {
      expect(resolveCursorCommand({ CURSOR_BIN: cursorBin })).toBe(cursorBin);
    });
  });

  it("does not treat the Cursor IDE binary as the CLI", () => {
    withExecutable("cursor", (cursorIde) => {
      expect(() => resolveCursorCommand({ PATH: join(cursorIde, "..") })).toThrow(
        /Cursor CLI not found/,
      );
    });
  });

  it("finds agent on PATH", () => {
    withExecutable("agent", (agentBin) => {
      expect(resolveCursorCommand({ PATH: join(agentBin, "..") })).toBe(agentBin);
    });
  });

  it("falls back to cursor-agent when agent is missing", () => {
    withExecutable("cursor-agent", (cursorAgent) => {
      const dir = join(cursorAgent, "..");
      expect(resolveCursorCommand({ PATH: dir })).toBe(cursorAgent);
    });
  });

  it("rejects JSON command construction", () => {
    withExecutable("agent", (cursorBin) => {
      expect(() => CURSOR_PROVIDER.buildJsonCommand({}, { CURSOR_BIN: cursorBin })).toThrow(
        CursorJsonUnsupportedError,
      );
    });
  });

  it("leaves local wrap argv unchanged", () => {
    withExecutable("agent", (cursorBin) => {
      const env = { CURSOR_BIN: cursorBin } as NodeJS.ProcessEnv;
      expect(CURSOR_PROVIDER.buildTerminalCommand({ args: ["--mode=ask"] }, env).args).toEqual([
        "--mode=ask",
      ]);
    });
  });

  it("injects --trust and permission flags for hosted PTY", () => {
    withExecutable("agent", (cursorBin) => {
      const env = { CURSOR_BIN: cursorBin } as NodeJS.ProcessEnv;
      expect(
        CURSOR_PROVIDER.buildTerminalCommand({ args: [], permissionMode: "default" }, env).args,
      ).toEqual(["--trust"]);
      expect(
        CURSOR_PROVIDER.buildTerminalCommand({ args: ["--resume", "abc"], permissionMode: "auto" }, env)
          .args,
      ).toEqual(["--resume", "abc", "--trust", "--auto-review"]);
      expect(
        CURSOR_PROVIDER.buildTerminalCommand({ args: [], permissionMode: "plan" }, env).args,
      ).toEqual(["--trust", "--mode=plan"]);
      expect(
        CURSOR_PROVIDER.buildTerminalCommand(
          { args: ["--", "fix tests"], permissionMode: "bypassPermissions" },
          env,
        ).args,
      ).toEqual(["--trust", "--yolo", "--", "fix tests"]);
    });
  });

  it("rejects unsupported hosted permission modes", () => {
    withExecutable("agent", (cursorBin) => {
      expect(() =>
        CURSOR_PROVIDER.buildTerminalCommand(
          { args: [], permissionMode: "acceptEdits" },
          { CURSOR_BIN: cursorBin },
        ),
      ).toThrow(CursorPermissionModeUnsupportedError);
    });
  });

  it("does not advertise hook support", () => {
    expect(CURSOR_PROVIDER.capabilities.supportsHooks).toBe(false);
  });
});
