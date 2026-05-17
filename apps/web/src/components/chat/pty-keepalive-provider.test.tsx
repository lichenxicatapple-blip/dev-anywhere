import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "@/stores/session-store";
import { PtyKeepAliveProvider, PtyKeepAliveViewport } from "./pty-keepalive-provider";

vi.mock("./chat-pty-view", () => ({
  ChatPtyView: ({
    sessionId,
    provider,
    active,
  }: {
    sessionId: string;
    provider?: "claude" | "codex";
    active?: boolean;
  }) => (
    <div
      data-slot="mock-chat-pty-view"
      data-session-id={sessionId}
      data-provider={provider}
      data-active={String(active)}
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
          name: "/tmp/project",
          cwd: "/tmp/project",
          state: "idle",
          mode: "pty",
          provider: "claude",
          ptyOwner: "proxy-hosted",
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
          <PtyKeepAliveViewport sessionId="pty-1" ptyOwner="proxy-hosted" />
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
          <PtyKeepAliveViewport sessionId="pty-1" provider="codex" ptyOwner="proxy-hosted" />
        </div>
      </PtyKeepAliveProvider>,
    );

    await waitFor(() => {
      const view = container.querySelector('[data-slot="mock-chat-pty-view"]');
      expect(view?.getAttribute("data-provider")).toBe("codex");
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
          <PtyKeepAliveViewport sessionId="pty-1" ptyOwner="proxy-hosted" />
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
