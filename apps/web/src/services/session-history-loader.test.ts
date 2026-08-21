import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistorySession } from "@dev-anywhere/shared";
import type { RelayClient } from "@/services/relay-client";
import { useAppStore } from "@/stores/app-store";
import { useSessionStore } from "@/stores/session-store";
import { loadSessionHistory } from "./session-history-loader";

const history: HistorySession[] = [
  {
    id: "history-1",
    title: "History",
    projectDir: "/workspace",
    updatedAt: 1,
    provider: "claude",
  },
];

function relayWithHistoryRequest(requestSessionHistory: RelayClient["requestSessionHistory"]) {
  return { requestSessionHistory } as RelayClient;
}

describe("loadSessionHistory", () => {
  beforeEach(() => {
    useAppStore.setState({ selectedProxyId: "proxy-1" });
    useSessionStore.setState({
      historySessions: [],
      historyLoadStatus: "idle",
      historyLoadGeneration: 0,
    });
  });

  it("exposes a real loading state until the selected proxy returns", async () => {
    let resolveHistory!: (sessions: HistorySession[]) => void;
    const request = vi.fn(
      () =>
        new Promise<HistorySession[]>((resolve) => {
          resolveHistory = resolve;
        }),
    );

    const pending = loadSessionHistory(relayWithHistoryRequest(request), 30_000);

    expect(useSessionStore.getState().historyLoadStatus).toBe("loading");
    expect(request).toHaveBeenCalledWith(30_000);

    resolveHistory(history);
    await expect(pending).resolves.toEqual({ status: "loaded", sessions: history });
    expect(useSessionStore.getState()).toMatchObject({
      historySessions: history,
      historyLoadStatus: "loaded",
    });
  });

  it("releases loading with an error when the request rejects or times out", async () => {
    const error = new Error("请求超时");
    const result = await loadSessionHistory(
      relayWithHistoryRequest(vi.fn().mockRejectedValue(error)),
    );

    expect(result).toEqual({ status: "failed", error });
    expect(useSessionStore.getState().historyLoadStatus).toBe("error");
  });

  it("does not let an older overlapping request end or overwrite the newer load", async () => {
    let resolveFirst!: (sessions: HistorySession[]) => void;
    let resolveSecond!: (sessions: HistorySession[]) => void;
    const request = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<HistorySession[]>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<HistorySession[]>((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const relay = relayWithHistoryRequest(request);

    const first = loadSessionHistory(relay);
    const second = loadSessionHistory(relay);
    resolveFirst(history);

    await expect(first).resolves.toEqual({ status: "stale" });
    expect(useSessionStore.getState()).toMatchObject({
      historySessions: [],
      historyLoadStatus: "loading",
    });

    resolveSecond([{ ...history[0], id: "history-2" }]);
    await expect(second).resolves.toMatchObject({ status: "loaded" });
    expect(useSessionStore.getState().historySessions.map((item) => item.id)).toEqual([
      "history-2",
    ]);
  });

  it("drops a response that arrives after switching proxies", async () => {
    let resolveHistory!: (sessions: HistorySession[]) => void;
    const pending = loadSessionHistory(
      relayWithHistoryRequest(
        vi.fn(
          () =>
            new Promise<HistorySession[]>((resolve) => {
              resolveHistory = resolve;
            }),
        ),
      ),
    );

    useSessionStore.getState().prepareForProxySwitch("Other proxy");
    useAppStore.setState({ selectedProxyId: "proxy-2" });
    resolveHistory(history);

    await expect(pending).resolves.toEqual({ status: "stale" });
    expect(useSessionStore.getState()).toMatchObject({
      historySessions: [],
      historyLoadStatus: "idle",
    });
  });
});
