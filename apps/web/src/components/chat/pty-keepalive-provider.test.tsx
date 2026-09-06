import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "@/stores/session-store";
import { PtyKeepAliveProvider, PtyKeepAliveViewport } from "./pty-keepalive-provider";

vi.mock("./chat-pty-view", () => ({
  ChatPtyView: ({
    sessionId,
    provider,
    active,
    findRequest,
    fitRequest,
  }: {
    sessionId: string;
    provider?: "claude" | "codex";
    active?: boolean;
    findRequest?: number;
    fitRequest?: string;
  }) => (
    <div
      data-slot="mock-chat-pty-view"
      data-session-id={sessionId}
      data-provider={provider}
      data-active={String(active)}
      data-find-request={findRequest}
      data-fit-request={fitRequest}
    />
  ),
}));

class ResizeObserverMock {
  observe(): void {}
  disconnect(): void {}
}

describe("PtyKeepAliveProvider", () => {
  beforeEach(() => {
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
    useSessionStore.setState({
      sessions: [
        {
          sessionId: "pty-1",
          kind: "agent",
          name: "/tmp/project",
          cwd: "/tmp/project",
          state: "idle",
          mode: "pty",
          provider: "claude",
          ptyOwner: "proxy-hosted",
          lastActive: 1,
        },
      ],
      sessionListLoaded: true,
      ptyTitles: {},
      ptyStateBySessionId: {},
      agentStatusBySessionId: {},
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("activates the initial PTY view on first mount without waiting for a later resize", async () => {
    const { container } = render(
      <PtyKeepAliveProvider>
        <div style={{ height: 200, width: 300 }}>
          <PtyKeepAliveViewport sessionId="pty-1" />
        </div>
      </PtyKeepAliveProvider>,
    );

    await waitFor(() => {
      const entry = container.querySelector(
        '[data-slot="pty-keepalive-entry"][data-session-id="pty-1"]',
      );
      expect(entry?.getAttribute("data-active")).toBe("true");
    });
  });

  it("passes the session provider through the keep-alive layer", async () => {
    const { container } = render(
      <PtyKeepAliveProvider>
        <div style={{ height: 200, width: 300 }}>
          <PtyKeepAliveViewport sessionId="pty-1" provider="codex" />
        </div>
      </PtyKeepAliveProvider>,
    );

    await waitFor(() => {
      const view = container.querySelector('[data-slot="mock-chat-pty-view"]');
      expect(view?.getAttribute("data-provider")).toBe("codex");
    });
  });

  it("forwards a find request without deactivating the PTY entry", async () => {
    const { container, rerender } = render(
      <PtyKeepAliveProvider>
        <div style={{ height: 200, width: 300 }}>
          <PtyKeepAliveViewport sessionId="pty-1" />
        </div>
      </PtyKeepAliveProvider>,
    );

    rerender(
      <PtyKeepAliveProvider>
        <div style={{ height: 200, width: 300 }}>
          <PtyKeepAliveViewport sessionId="pty-1" findRequest={1} />
        </div>
      </PtyKeepAliveProvider>,
    );

    await waitFor(() => {
      const entry = container.querySelector(
        '[data-slot="pty-keepalive-entry"][data-session-id="pty-1"]',
      );
      const view = container.querySelector('[data-slot="mock-chat-pty-view"]');
      expect(entry?.getAttribute("data-active")).toBe("true");
      expect(view?.getAttribute("data-find-request")).toBe("1");
    });
  });

  it("forwards fit commands only to the requested active entry without remounting it", async () => {
    const original = useSessionStore.getState().sessions[0]!;
    useSessionStore.setState({
      sessions: [original, { ...original, sessionId: "pty-2" }],
    });
    const view = (sessionId: string, fitRequest?: string) => (
      <PtyKeepAliveProvider>
        <PtyKeepAliveViewport sessionId={sessionId} fitRequest={fitRequest} />
      </PtyKeepAliveProvider>
    );
    const { container, rerender } = render(view("pty-1"));
    const first = container.querySelector(
      '[data-slot="mock-chat-pty-view"][data-session-id="pty-1"]',
    );
    rerender(view("pty-1", "fit-1"));
    await waitFor(() => expect(first?.getAttribute("data-fit-request")).toBe("fit-1"));
    rerender(view("pty-2"));
    rerender(view("pty-2", "fit-2"));
    await waitFor(() => {
      const second = container.querySelector(
        '[data-slot="mock-chat-pty-view"][data-session-id="pty-2"]',
      );
      expect(second?.getAttribute("data-fit-request")).toBe("fit-2");
      expect(second?.getAttribute("data-active")).toBe("true");
    });
    expect(
      container.querySelector('[data-slot="mock-chat-pty-view"][data-session-id="pty-1"]'),
    ).toBe(first);
    expect(first?.getAttribute("data-fit-request")).toBe("fit-1");
    expect(first?.getAttribute("data-active")).toBe("false");
  });

  it("keeps every visited live PTY mounted without a capacity limit", async () => {
    useSessionStore.setState({
      sessions: ["pty-1", "pty-2", "pty-3", "pty-4"].map((sessionId) => ({
        sessionId,
        kind: "agent" as const,
        name: `/tmp/${sessionId}`,
        cwd: `/tmp/${sessionId}`,
        state: "idle" as const,
        mode: "pty" as const,
        provider: "codex" as const,
        ptyOwner: "proxy-hosted" as const,
        lastActive: 1,
      })),
      sessionListLoaded: true,
    });

    const renderView = (sessionId: string) => (
      <PtyKeepAliveProvider>
        <div style={{ height: 200, width: 300 }}>
          <PtyKeepAliveViewport sessionId={sessionId} provider="codex" />
        </div>
      </PtyKeepAliveProvider>
    );
    const { container, rerender } = render(renderView("pty-1"));
    rerender(renderView("pty-2"));
    rerender(renderView("pty-3"));
    rerender(renderView("pty-4"));

    await waitFor(() => {
      const entries = container.querySelectorAll('[data-slot="pty-keepalive-entry"]');
      expect(Array.from(entries, (entry) => entry.getAttribute("data-session-id"))).toEqual([
        "pty-1",
        "pty-2",
        "pty-3",
        "pty-4",
      ]);
    });
  });

  it("does not prune the route PTY entry before the session list has loaded", async () => {
    useSessionStore.setState({
      sessions: [],
      sessionListLoaded: false,
      ptyTitles: {},
      ptyStateBySessionId: {},
      agentStatusBySessionId: {},
    });

    const { container } = render(
      <PtyKeepAliveProvider>
        <div style={{ height: 200, width: 300 }}>
          <PtyKeepAliveViewport sessionId="pty-1" />
        </div>
      </PtyKeepAliveProvider>,
    );

    await waitFor(() => {
      const entry = container.querySelector(
        '[data-slot="pty-keepalive-entry"][data-session-id="pty-1"]',
      );
      expect(entry?.getAttribute("data-active")).toBe("true");
    });
  });
});
