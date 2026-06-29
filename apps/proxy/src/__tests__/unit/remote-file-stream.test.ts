import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlErrorCode } from "@dev-anywhere/shared";
import { RemoteFileStreamManager } from "#src/serve/remote-file-stream.js";
import type { RelayConnection } from "#src/serve/relay-connection.js";
import type { SessionManager } from "#src/serve/session-manager.js";
import { createSessionManagerFake } from "./test-fakes.js";

describe("RemoteFileStreamManager metadata", () => {
  let dir: string;
  let sent: string[];
  let manager: RemoteFileStreamManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dev-anywhere-remote-file-stream-"));
    sent = [];
    manager = new RemoteFileStreamManager({
      relayConnection: {
        sendRaw: vi.fn((raw: string) => {
          sent.push(raw);
        }),
      } as unknown as RelayConnection,
      sessionManager: createSessionManagerFake([{ id: "s1", cwd: dir }]) as SessionManager,
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function lastControl() {
    return JSON.parse(sent.at(-1) ?? "{}") as Record<string, unknown>;
  }

  it("resolves relative metadata from the session cwd without opening a stream", () => {
    const skillsDir = join(dir, "pa_break_analysis");
    mkdirSync(skillsDir);
    writeFileSync(join(skillsDir, "SKILL.md"), "hello");

    manager.metadata({
      type: "remote_file_metadata_request",
      requestId: "meta-1",
      sessionId: "s1",
      path: "pa_break_analysis/SKILL.md",
    });

    expect(lastControl()).toMatchObject({
      type: "remote_file_metadata_response",
      requestId: "meta-1",
      sessionId: "s1",
      path: "pa_break_analysis/SKILL.md",
      success: true,
      mimeType: "text/markdown",
      size: 5,
      fileName: "SKILL.md",
    });
  });

  it("rejects missing paths before a browser download URL is issued", () => {
    manager.metadata({
      type: "remote_file_metadata_request",
      requestId: "meta-missing",
      sessionId: "s1",
      path: "pa_break_analysis/SKILL.md",
    });

    expect(lastControl()).toMatchObject({
      type: "remote_file_metadata_response",
      requestId: "meta-missing",
      sessionId: "s1",
      path: "pa_break_analysis/SKILL.md",
      success: false,
      errorCode: ControlErrorCode.PATH_NOT_FOUND,
    });
  });

  it("rejects directories as invalid download targets", () => {
    mkdirSync(join(dir, "pa_break_analysis"));

    manager.metadata({
      type: "remote_file_metadata_request",
      requestId: "meta-dir",
      sessionId: "s1",
      path: "pa_break_analysis",
    });

    expect(lastControl()).toMatchObject({
      type: "remote_file_metadata_response",
      requestId: "meta-dir",
      sessionId: "s1",
      path: "pa_break_analysis",
      success: false,
      errorCode: ControlErrorCode.INVALID_PATH,
    });
  });
});
