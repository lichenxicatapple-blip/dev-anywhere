import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAppStore } from "@/stores/app-store";
import { useSessionStore } from "@/stores/session-store";
import { touchPtyKeepAliveEntry, type PtyKeepAliveEntry } from "@/lib/pty-keepalive-cache";
import type { SessionProvider } from "@/lib/session-provider";
import { ImagePreviewProvider } from "./image-preview";
import { ChatPtyView } from "./chat-pty-view";

type PtyOwner = "local-terminal" | "proxy-hosted";

interface CachedPtyEntry extends PtyKeepAliveEntry {
  provider?: SessionProvider;
  ptyOwner?: PtyOwner;
}

interface ViewportRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface ActivePtyView {
  sessionId: string;
  provider?: SessionProvider;
  ptyOwner?: PtyOwner;
}

interface PtyKeepAliveContextValue {
  activate: (view: ActivePtyView) => void;
  deactivate: (sessionId: string) => void;
  updateViewportRect: (sessionId: string, rect: ViewportRect | null) => void;
}

const PTY_KEEP_ALIVE_CAPACITY = 3;
const HIDDEN_WIDTH = 1024;
const HIDDEN_HEIGHT = 720;
const RECT_EPSILON_PX = 0.5;

const PtyKeepAliveContext = createContext<PtyKeepAliveContextValue | null>(null);

export function PtyKeepAliveProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<CachedPtyEntry[]>([]);
  const [activeView, setActiveView] = useState<ActivePtyView | null>(null);
  const [viewportRect, setViewportRect] = useState<ViewportRect | null>(null);
  const selectedProxyId = useAppStore((s) => s.selectedProxyId);
  const sessions = useSessionStore((s) => s.sessions);
  const sessionListLoaded = useSessionStore((s) => s.sessionListLoaded);
  const previousProxyIdRef = useRef<string | null>(selectedProxyId);
  const activeSessionIdRef = useRef<string | null>(null);

  const activeSessionIdsKey = useMemo(
    () =>
      sessions
        .filter((session) => session.mode === "pty")
        .map((session) => session.sessionId)
        .sort()
        .join("\n"),
    [sessions],
  );

  const activate = useCallback((view: ActivePtyView): void => {
    activeSessionIdRef.current = view.sessionId;
    setActiveView(view);
    setEntries((current) => {
      const touched = touchPtyKeepAliveEntry(current, view.sessionId, {
        capacity: PTY_KEEP_ALIVE_CAPACITY,
        now: Date.now(),
        activeSessionId: view.sessionId,
      });
      return touched.map((entry) =>
        entry.sessionId === view.sessionId
          ? { ...entry, provider: view.provider, ptyOwner: view.ptyOwner }
          : entry,
      );
    });
  }, []);

  const deactivate = useCallback((sessionId: string): void => {
    if (activeSessionIdRef.current === sessionId) activeSessionIdRef.current = null;
    setActiveView((current) => (current?.sessionId === sessionId ? null : current));
    setViewportRect((current) => (activeSessionIdRef.current === null ? null : current));
  }, []);

  const updateViewportRect = useCallback((sessionId: string, rect: ViewportRect | null): void => {
    if (activeSessionIdRef.current !== sessionId) return;
    setViewportRect((current) => {
      if (!rect) return current;
      if (current && viewportRectsEqual(current, rect)) return current;
      return rect;
    });
  }, []);

  useEffect(() => {
    if (!sessionListLoaded) return;
    const activeIds = new Set(activeSessionIdsKey ? activeSessionIdsKey.split("\n") : []);
    setEntries((current) => current.filter((entry) => activeIds.has(entry.sessionId)));
    setActiveView((current) => (current && activeIds.has(current.sessionId) ? current : null));
    if (activeSessionIdRef.current && !activeIds.has(activeSessionIdRef.current)) {
      activeSessionIdRef.current = null;
      setViewportRect(null);
    }
  }, [activeSessionIdsKey, sessionListLoaded]);

  useEffect(() => {
    const previousProxyId = previousProxyIdRef.current;
    previousProxyIdRef.current = selectedProxyId;
    if (!previousProxyId || previousProxyId === selectedProxyId) return;
    activeSessionIdRef.current = null;
    setEntries([]);
    setActiveView(null);
    setViewportRect(null);
  }, [selectedProxyId]);

  const contextValue = useMemo<PtyKeepAliveContextValue>(
    () => ({ activate, deactivate, updateViewportRect }),
    [activate, deactivate, updateViewportRect],
  );

  return (
    <PtyKeepAliveContext.Provider value={contextValue}>
      {children}
      <PtyKeepAliveLayer entries={entries} activeView={activeView} viewportRect={viewportRect} />
    </PtyKeepAliveContext.Provider>
  );
}

export function PtyKeepAliveViewport({
  sessionId,
  provider,
  ptyOwner,
}: {
  sessionId: string;
  provider?: SessionProvider;
  ptyOwner?: PtyOwner;
}) {
  const context = useContext(PtyKeepAliveContext);
  const ref = useRef<HTMLDivElement>(null);

  if (!context) {
    throw new Error("PtyKeepAliveViewport must be used within PtyKeepAliveProvider");
  }

  const { activate, deactivate, updateViewportRect } = context;

  useLayoutEffect(() => {
    activate({ sessionId, provider, ptyOwner });
    return () => deactivate(sessionId);
  }, [activate, deactivate, sessionId, provider, ptyOwner]);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;

    const measure = (): void => {
      const rect = node.getBoundingClientRect();
      updateViewportRect(sessionId, {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      });
    };

    measure();
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(node);
    window.addEventListener("resize", measure);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [sessionId, updateViewportRect]);

  return (
    <div
      ref={ref}
      className="h-full w-full bg-background"
      data-slot="pty-keepalive-viewport"
      data-session-id={sessionId}
    />
  );
}

function PtyKeepAliveLayer({
  entries,
  activeView,
  viewportRect,
}: {
  entries: CachedPtyEntry[];
  activeView: ActivePtyView | null;
  viewportRect: ViewportRect | null;
}) {
  if (entries.length === 0) return null;

  return (
    <div className="fixed inset-0 z-10 pointer-events-none" data-slot="pty-keepalive-layer">
      {entries.map((entry) => {
        const active = activeView?.sessionId === entry.sessionId && viewportRect !== null;
        const rect = active
          ? viewportRect
          : {
              top: -100_000,
              left: 0,
              width: viewportRect?.width ?? HIDDEN_WIDTH,
              height: viewportRect?.height ?? HIDDEN_HEIGHT,
            };
        return (
          <div
            key={entry.sessionId}
            className="absolute overflow-hidden bg-background"
            data-slot="pty-keepalive-entry"
            data-session-id={entry.sessionId}
            data-active={active ? "true" : "false"}
            aria-hidden={!active}
            style={{
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height,
              pointerEvents: active ? "auto" : "none",
              visibility: active ? "visible" : "hidden",
            }}
          >
            <ImagePreviewProvider sessionId={entry.sessionId}>
              <ChatPtyView
                sessionId={entry.sessionId}
                provider={entry.provider}
                ptyOwner={entry.ptyOwner}
                active={active}
              />
            </ImagePreviewProvider>
          </div>
        );
      })}
    </div>
  );
}

function viewportRectsEqual(a: ViewportRect, b: ViewportRect): boolean {
  return (
    Math.abs(a.top - b.top) <= RECT_EPSILON_PX &&
    Math.abs(a.left - b.left) <= RECT_EPSILON_PX &&
    Math.abs(a.width - b.width) <= RECT_EPSILON_PX &&
    Math.abs(a.height - b.height) <= RECT_EPSILON_PX
  );
}
