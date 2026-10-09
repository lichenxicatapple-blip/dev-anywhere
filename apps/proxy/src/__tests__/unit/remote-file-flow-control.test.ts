import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFileStreamFrame, type RelayControlMessage } from "@dev-anywhere/shared";
import { RemoteFileStreamManager } from "#src/serve/remote-file-stream.js";
import type { RelayConnection } from "#src/serve/relay-connection.js";
import { createSessionManagerFake } from "./test-fakes.js";

describe("remote file streaming backpressure", () => {
  let dir: string;
  let manager: RemoteFileStreamManager;
  let controls: RelayControlMessage[];
  let sequences: number[];
  let bytesRead: number;
  let autoAcknowledge: boolean;
  const size = 8 * 1024 * 1024;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dev-anywhere-file-credits-"));
    writeFileSync(join(dir, "video.mp4"), "");
    truncateSync(join(dir, "video.mp4"), size);
    controls = [];
    sequences = [];
    bytesRead = 0;
    autoAcknowledge = false;
    manager = new RemoteFileStreamManager({
      relayConnection: {
        sendRaw(raw: string) {
          controls.push(JSON.parse(raw) as RelayControlMessage);
        },
        sendBinary(data: Uint8Array) {
          const frame = decodeFileStreamFrame(data);
          if (!frame) throw new Error("Invalid file frame");
          sequences.push(frame.chunkSeq);
          bytesRead += frame.data.byteLength;
          if (autoAcknowledge) {
            queueMicrotask(() =>
              manager.acknowledge({
                type: "remote_file_stream_ack",
                streamId: frame.streamId,
                chunkSeq: frame.chunkSeq,
              }),
            );
          }
        },
      } as unknown as RelayConnection,
      sessionManager: createSessionManagerFake([
        {
          id: "s1",
          kind: "agent",
          mode: "json",
          provider: "claude",
          state: "idle",
          createdAt: 1,
          updatedAt: 1,
          cwd: dir,
          pid: 1,
        },
      ]),
    });
  });

  afterEach(() => {
    manager.cancelAll();
    rmSync(dir, { recursive: true, force: true });
  });

  function start(flowControl?: boolean) {
    manager.start({
      type: "remote_file_stream_request",
      streamId: "stream",
      sessionId: "s1",
      path: "video.mp4",
      disposition: "inline",
      ...(flowControl === undefined ? {} : { flowControl }),
    });
  }

  function acknowledge(chunkSeq: number) {
    manager.acknowledge({ type: "remote_file_stream_ack", streamId: "stream", chunkSeq });
  }

  it("reads only a fixed window while the HTTP consumer provides no credit", async () => {
    start(true);
    await vi.waitFor(() => expect(sequences).toHaveLength(4));
    expect(bytesRead).toBe(1024 * 1024);
    expect(controls.some((msg) => msg.type === "remote_file_stream_complete")).toBe(false);

    acknowledge(999); // An acknowledgement for unsent data must not release credit.
    await setImmediate();
    expect(sequences).toHaveLength(4);
    acknowledge(0);
    await vi.waitFor(() => expect(sequences).toHaveLength(5));
    acknowledge(0); // Neither may a duplicate grant another chunk.
    await setImmediate();
    expect(sequences).toHaveLength(5);

    autoAcknowledge = true;
    acknowledge(4);
    await vi.waitFor(() =>
      expect(controls.at(-1)).toMatchObject({
        type: "remote_file_stream_complete",
        success: true,
      }),
    );
    expect(bytesRead).toBe(size);
    expect(sequences).toEqual(Array.from({ length: 32 }, (_, index) => index));
  });

  it("continues streaming to an old relay that did not request credits", async () => {
    start();
    await vi.waitFor(() =>
      expect(controls.at(-1)).toMatchObject({
        type: "remote_file_stream_complete",
        success: true,
      }),
    );
    expect(bytesRead).toBe(size);
    expect(controls[0]).not.toHaveProperty("flowControl");
  });

  it("destroys paused disk streams when disconnected, ignoring late credits", async () => {
    start(true);
    await vi.waitFor(() => expect(sequences).toHaveLength(4));
    manager.cancelAll();
    acknowledge(3);
    await setImmediate();
    await setImmediate();
    expect(sequences).toHaveLength(4);
    expect(controls.some((msg) => msg.type === "remote_file_stream_complete")).toBe(false);
  });

  it("waits for the final HTTP write before completing a partial window", async () => {
    writeFileSync(join(dir, "video.mp4"), "small video");
    start(true);
    await vi.waitFor(() => expect(sequences).toHaveLength(1));
    expect(controls.some((msg) => msg.type === "remote_file_stream_complete")).toBe(false);
    acknowledge(0);
    await vi.waitFor(() =>
      expect(controls.at(-1)).toMatchObject({
        type: "remote_file_stream_complete",
        success: true,
      }),
    );
    expect(bytesRead).toBe(11);
  });
});
