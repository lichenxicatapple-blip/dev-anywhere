import { useCallback, useEffect, useRef, useState } from "react";
import { FileDown, Loader2 } from "lucide-react";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import {
  captureAndPersistBrowserStateDump,
  getBrowserStateDumpMode,
  type BrowserStateDumpMode,
  type BrowserStateDumpPersistResult,
} from "@/lib/browser-state-dump";

declare global {
  interface Window {
    __devAnywhereDumpBrowserState?: (
      trigger?: string,
    ) => Promise<BrowserStateDumpPersistResult>;
  }
}

const AUTO_DUMP_DEBOUNCE_MS = 500;
const AUTO_DUMP_MIN_INTERVAL_MS = 1000;
const AUTO_DUMP_MAX_PER_PAGE = 60;

export function BrowserStateDumpController() {
  const [mode, setMode] = useState<BrowserStateDumpMode>(() => getBrowserStateDumpMode());
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<BrowserStateDumpPersistResult | null>(null);
  const lastResultRef = useRef<BrowserStateDumpPersistResult | null>(null);
  const busyRef = useRef(false);
  const lastDumpAtRef = useRef(0);
  const autoCountRef = useRef(0);
  const pendingTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const update = () => setMode(getBrowserStateDumpMode());
    window.addEventListener("hashchange", update);
    window.addEventListener("popstate", update);
    return () => {
      window.removeEventListener("hashchange", update);
      window.removeEventListener("popstate", update);
    };
  }, []);

  const dump = useCallback(async (trigger: string = "manual") => {
    if (busyRef.current) {
      return lastResultRef.current ?? { status: "failed", error: "dump already running" };
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await captureAndPersistBrowserStateDump(trigger);
      lastResultRef.current = result;
      setLastResult(result);
      if (trigger === "manual" || result.status === "failed") {
        showDumpToast(result);
      }
      return result;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    window.__devAnywhereDumpBrowserState = dump;
    return () => {
      if (window.__devAnywhereDumpBrowserState === dump) {
        delete window.__devAnywhereDumpBrowserState;
      }
    };
  }, [dump]);

  useEffect(() => {
    if (mode !== "auto") return;

    const clearPending = () => {
      if (pendingTimerRef.current === null) return;
      window.clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    };

    const schedule = (reason: string) => {
      if (autoCountRef.current >= AUTO_DUMP_MAX_PER_PAGE) return;
      clearPending();
      pendingTimerRef.current = window.setTimeout(() => {
        pendingTimerRef.current = null;
        const now = Date.now();
        const wait = AUTO_DUMP_MIN_INTERVAL_MS - (now - lastDumpAtRef.current);
        if (wait > 0) {
          pendingTimerRef.current = window.setTimeout(() => schedule(reason), wait);
          return;
        }
        lastDumpAtRef.current = Date.now();
        autoCountRef.current += 1;
        void dump(`auto:${autoCountRef.current}:${reason}`);
      }, AUTO_DUMP_DEBOUNCE_MS);
    };

    schedule("initial");
    const eventTypes = [
      "focusin",
      "focusout",
      "beforeinput",
      "input",
      "compositionstart",
      "compositionupdate",
      "compositionend",
      "keydown",
      "keyup",
      "pointerdown",
      "pointerup",
      "resize",
      "visibilitychange",
    ] as const;
    const onEvent = (event: Event) => schedule(event.type);
    eventTypes.forEach((type) => window.addEventListener(type, onEvent, true));
    window.visualViewport?.addEventListener("resize", onEvent);
    window.visualViewport?.addEventListener("scroll", onEvent);
    return () => {
      clearPending();
      eventTypes.forEach((type) => window.removeEventListener(type, onEvent, true));
      window.visualViewport?.removeEventListener("resize", onEvent);
      window.visualViewport?.removeEventListener("scroll", onEvent);
    };
  }, [dump, mode]);

  if (mode === "off") return null;

  const label = mode === "auto" ? "自动诊断中" : "保存诊断";
  const detail = formatDumpResult(lastResult);
  return (
    <div className="fixed bottom-3 right-3 z-[90] flex max-w-[min(360px,calc(100vw-24px))] flex-col items-end gap-1">
      {detail ? (
        <div className="max-w-full truncate rounded-md border border-border/70 bg-popover/95 px-2 py-1 text-[10px] text-muted-foreground shadow">
          {detail}
        </div>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant={mode === "auto" ? "secondary" : "outline"}
        className="h-9 rounded-md px-3 text-xs shadow-lg"
        onClick={() => void dump("manual")}
        disabled={busy}
        data-slot="browser-state-dump"
      >
        {busy ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <FileDown className="size-3.5" aria-hidden="true" />
        )}
        <span>{label}</span>
      </Button>
    </div>
  );
}

function showDumpToast(result: BrowserStateDumpPersistResult): void {
  if (result.status === "saved") {
    toast.success(`诊断已保存: ${result.path}`);
    return;
  }
  if (result.status === "downloaded") {
    toast.info(`诊断已下载: ${result.filename}`);
    return;
  }
  toast.error(result.endpointError ? `${result.error}: ${result.endpointError}` : result.error);
}

function formatDumpResult(result: BrowserStateDumpPersistResult | null): string | null {
  if (!result) return null;
  if (result.status === "saved") return `已保存 ${result.path}`;
  if (result.status === "downloaded") return `已下载 ${result.filename}`;
  return `失败 ${result.endpointError ?? result.error}`;
}
