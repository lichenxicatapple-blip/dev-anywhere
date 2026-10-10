import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { cursorAcpSessionsDir } from "#src/serve/history/paths.js";

const ENV_KEYS = ["CURSOR_ACP_SESSIONS_DIR", "CURSOR_CONFIG_DIR", "XDG_CONFIG_HOME"] as const;

describe("cursorAcpSessionsDir", () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("defaults to ~/.cursor/acp-sessions", () => {
    expect(cursorAcpSessionsDir()).toBe(join(homedir(), ".cursor", "acp-sessions"));
  });

  it("follows CURSOR_CONFIG_DIR like the Cursor CLI does", () => {
    process.env.CURSOR_CONFIG_DIR = "/custom/cursor-root";
    expect(cursorAcpSessionsDir()).toBe(join("/custom/cursor-root", "acp-sessions"));
  });

  it("falls back to $XDG_CONFIG_HOME/cursor, with CURSOR_CONFIG_DIR taking priority", () => {
    process.env.XDG_CONFIG_HOME = "/xdg/config";
    expect(cursorAcpSessionsDir()).toBe(join("/xdg/config", "cursor", "acp-sessions"));
    process.env.CURSOR_CONFIG_DIR = "/custom/cursor-root";
    expect(cursorAcpSessionsDir()).toBe(join("/custom/cursor-root", "acp-sessions"));
  });

  it("uses an explicit CURSOR_ACP_SESSIONS_DIR as the history directory without appending", () => {
    process.env.CURSOR_CONFIG_DIR = "/custom/cursor-root";
    process.env.CURSOR_ACP_SESSIONS_DIR = "/explicit/history";
    expect(cursorAcpSessionsDir()).toBe(resolve("/explicit/history"));
  });
});
