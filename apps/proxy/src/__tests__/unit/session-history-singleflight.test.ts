import { beforeEach, describe, expect, it, vi } from "vitest";
import { createControlMessageHandlers } from "#src/serve/handlers/control-messages.js";
import { scanSessionHistory } from "#src/serve/history/catalog.js";
import { createSessionManagerFake } from "./test-fakes.js";

vi.mock("#src/serve/history/catalog.js", () => ({
  scanSessionHistory: vi.fn(),
}));

const mockedScanSessionHistory = vi.mocked(scanSessionHistory);

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("session history refresh-storm singleflight", () => {
  beforeEach(() => {
    mockedScanSessionHistory.mockReset();
  });

  it("fans 35 overlapping requests into one scan while preserving every requestId", async () => {
    const scan = deferred<Awaited<ReturnType<typeof scanSessionHistory>>>();
    mockedScanSessionHistory.mockReturnValueOnce(scan.promise).mockResolvedValueOnce([
      {
        id: "history-after-completion",
        title: "Fresh scan",
        projectDir: "/workspace",
        updatedAt: 124,
        provider: "claude",
      },
    ]);

    const sent: string[] = [];
    const handlers = createControlMessageHandlers(
      (data) => sent.push(data),
      createSessionManagerFake(),
    );
    const requests = Array.from({ length: 35 }, (_, index) =>
      handlers.handleSessionHistoryRequest({ requestId: `refresh-${index}` }),
    );

    expect(mockedScanSessionHistory).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);

    const sessions = [
      {
        id: "history-1",
        title: "Shared scan result",
        projectDir: "/workspace",
        updatedAt: 123,
        provider: "claude" as const,
      },
    ];
    scan.resolve(sessions);
    await Promise.all(requests);

    const responses = sent.map((raw) => JSON.parse(raw)) as Array<{
      type: string;
      requestId: string;
      success: boolean;
      sessions: typeof sessions;
    }>;
    expect(responses).toHaveLength(35);
    expect(new Set(responses.map((response) => response.requestId))).toEqual(
      new Set(Array.from({ length: 35 }, (_, index) => `refresh-${index}`)),
    );
    expect(responses.every((response) => response.type === "session_history_response")).toBe(true);
    expect(responses.every((response) => response.success)).toBe(true);
    expect(responses.every((response) => response.sessions[0]?.id === "history-1")).toBe(true);

    await handlers.handleSessionHistoryRequest({ requestId: "after-completion" });

    expect(mockedScanSessionHistory).toHaveBeenCalledTimes(2);
    expect(JSON.parse(sent.at(-1) ?? "{}")).toMatchObject({
      requestId: "after-completion",
      success: true,
      sessions: [{ id: "history-after-completion" }],
    });
  });

  it("shares a failed scan and clears the flight so the next request can retry", async () => {
    const firstScan = deferred<Awaited<ReturnType<typeof scanSessionHistory>>>();
    const sessions = [
      {
        id: "history-after-retry",
        title: "Recovered",
        projectDir: "/workspace",
        updatedAt: 456,
        provider: "codex" as const,
      },
    ];
    mockedScanSessionHistory.mockReturnValueOnce(firstScan.promise).mockResolvedValueOnce(sessions);

    const sent: string[] = [];
    const handlers = createControlMessageHandlers(
      (data) => sent.push(data),
      createSessionManagerFake(),
    );
    const failedRequests = Array.from({ length: 12 }, (_, index) =>
      handlers.handleSessionHistoryRequest({ requestId: `failed-${index}` }),
    );

    expect(mockedScanSessionHistory).toHaveBeenCalledTimes(1);
    firstScan.reject(new Error("synthetic scan failure"));
    await Promise.all(failedRequests);

    const failures = sent.map((raw) => JSON.parse(raw)) as Array<{
      requestId: string;
      success: boolean;
      sessions: unknown[];
    }>;
    expect(failures).toHaveLength(12);
    expect(failures.every((response) => !response.success)).toBe(true);
    expect(failures.every((response) => response.sessions.length === 0)).toBe(true);

    await handlers.handleSessionHistoryRequest({ requestId: "retry" });

    expect(mockedScanSessionHistory).toHaveBeenCalledTimes(2);
    expect(JSON.parse(sent.at(-1) ?? "{}")).toMatchObject({
      type: "session_history_response",
      requestId: "retry",
      success: true,
      sessions: [{ id: "history-after-retry" }],
    });
  });
});
