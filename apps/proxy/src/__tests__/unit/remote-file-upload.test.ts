import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFileStreamFrame, SessionState } from "@dev-anywhere/shared";
import { RemoteFileUploadManager } from "#src/serve/remote-file-upload.js";
import type { RelayConnection } from "#src/serve/relay-connection.js";
import type { SessionManager } from "#src/serve/session-manager.js";

async function waitFor(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("waitFor timed out");
}

describe("RemoteFileUploadManager", () => {
  let dataDir: string;
  let relayConnection: Pick<RelayConnection, "sendRaw">;
  let sessionManager: Pick<SessionManager, "getSession">;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "dev-anywhere-upload-"));
    relayConnection = { sendRaw: vi.fn() };
    sessionManager = {
      getSession: vi.fn(() => ({
        id: "s1",
        mode: "pty" as const,
        provider: "claude" as const,
        state: SessionState.IDLE,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        cwd: dataDir,
        pid: 1,
      })),
    };
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("writes streamed upload chunks and returns the created path", async () => {
    const manager = new RemoteFileUploadManager({
      relayConnection: relayConnection as RelayConnection,
      sessionManager: sessionManager as SessionManager,
      dataDir,
      randomSuffix: () => "abc123",
    });

    manager.start({
      type: "remote_file_upload_stream_request",
      uploadId: "upload-1",
      sessionId: "s1",
      kind: "file",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
    });
    expect(
      manager.handleBinary(
        Buffer.from(encodeFileStreamFrame("upload-1", 0, Buffer.from("hello "))),
      ),
    ).toBe(true);
    expect(
      manager.handleBinary(Buffer.from(encodeFileStreamFrame("upload-1", 1, Buffer.from("world")))),
    ).toBe(true);
    manager.complete({ type: "remote_file_upload_stream_complete", uploadId: "upload-1" });

    await waitFor(() => expect(relayConnection.sendRaw).toHaveBeenCalledTimes(1));
    const response = JSON.parse(vi.mocked(relayConnection.sendRaw).mock.calls[0]?.[0] ?? "{}");
    expect(response).toMatchObject({
      type: "remote_file_upload_stream_response",
      uploadId: "upload-1",
      sessionId: "s1",
      success: true,
      path: join(dataDir, "up-abc123.txt"),
    });
    expect(readFileSync(response.path, "utf8")).toBe("hello world");
  });

  it("rejects unsupported clipboard image mime types before creating a file", async () => {
    const manager = new RemoteFileUploadManager({
      relayConnection: relayConnection as RelayConnection,
      sessionManager: sessionManager as SessionManager,
      dataDir,
      randomSuffix: () => "badmime",
    });

    manager.start({
      type: "remote_file_upload_stream_request",
      uploadId: "upload-2",
      sessionId: "s1",
      kind: "clipboard_image",
      fileName: "shot.bmp",
      mimeType: "image/bmp",
      size: 10,
    });

    expect(relayConnection.sendRaw).toHaveBeenCalledTimes(1);
    const response = JSON.parse(vi.mocked(relayConnection.sendRaw).mock.calls[0]?.[0] ?? "{}");
    expect(response).toMatchObject({
      type: "remote_file_upload_stream_response",
      uploadId: "upload-2",
      sessionId: "s1",
      success: false,
      error: "不支持这种图片格式",
    });
    expect(existsSync(join(dataDir, "paste-badmime.bmp"))).toBe(false);
  });
});
