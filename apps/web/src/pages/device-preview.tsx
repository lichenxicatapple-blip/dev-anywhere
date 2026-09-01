import { ArrowLeft, Home, Loader2, MonitorSmartphone, RotateCw, Send, Undo2 } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router";
import type { DevicePreviewInput } from "@dev-anywhere/shared";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/toast";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { devicePointerGesture, normalizedPointInDeviceFrame } from "@/lib/device-preview-pointer";
import { cn } from "@/lib/utils";
import { LatestDevicePreviewFramePainter } from "@/services/device-preview-frame-painter";
import { consumeDevicePreviewStream } from "@/services/device-preview-stream";
import type { DevicePreviewStreamAccess } from "@/services/relay-client";
import { useDevicePreviewStore } from "@/stores/device-preview-store";

type StreamStatus = "waiting" | "connecting" | "streaming" | "error";

interface PointerStart {
  pointerId: number;
  clientX: number;
  clientY: number;
  startedAt: number;
  point: { x: number; y: number };
}

export function DevicePreviewPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const preview = useDevicePreviewStore((state) =>
    state.previews.find((candidate) => candidate.previewId === id),
  );
  const listLoaded = useDevicePreviewStore((state) => state.listLoaded);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const painterRef = useRef<LatestDevicePreviewFramePainter | null>(null);
  const pointerStartRef = useRef<PointerStart | null>(null);
  const [streamGeneration, setStreamGeneration] = useState(0);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("waiting");
  const [streamError, setStreamError] = useState<string | null>(null);
  const [access, setAccess] = useState<DevicePreviewStreamAccess | null>(null);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [text, setText] = useState("");
  const [sendingText, setSendingText] = useState(false);
  const [claimingControl, setClaimingControl] = useState(false);
  const previewId = preview?.previewId;
  const previewState = preview?.state;
  const previewPlatform = preview?.platform;
  const previewError = preview?.error;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const painter = new LatestDevicePreviewFramePainter(canvas, setFrameSize);
    painter.reset(true);
    setFrameSize(null);
    painterRef.current = painter;
    return () => {
      painter.dispose();
      painterRef.current = null;
    };
  }, [previewId]);

  useEffect(() => {
    pointerStartRef.current = null;
    setAccess(null);
    setClaimingControl(false);
    if (!previewId || previewState !== "ready") {
      if (previewState === "starting") {
        setStreamStatus("connecting");
        setStreamError(null);
      } else if (previewState === "failed" || previewState === "disconnected") {
        setStreamStatus("error");
        setStreamError(previewError ?? "模拟器已经断开");
      } else {
        setStreamStatus("waiting");
        setStreamError(null);
      }
      return;
    }
    const relay = relayClientRef;
    if (!relay) {
      setStreamStatus("error");
      setStreamError("开发机连接已断开");
      return;
    }

    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let activeAbort: AbortController | null = null;
    let retryAttempt = 0;

    const stop = (): void => {
      activeAbort?.abort();
      activeAbort = null;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    };

    const schedule = (): void => {
      if (disposed || document.visibilityState === "hidden") return;
      const delay = Math.min(5_000, 500 * 2 ** retryAttempt);
      retryAttempt += 1;
      retryTimer = setTimeout(() => void connect(), delay);
    };

    const connect = async (): Promise<void> => {
      stop();
      if (disposed || document.visibilityState === "hidden") return;
      pointerStartRef.current = null;
      painterRef.current?.reset();
      setFrameSize(null);
      setStreamStatus("connecting");
      setStreamError(null);
      setAccess(null);
      const abort = new AbortController();
      activeAbort = abort;
      try {
        const nextAccess = await relay.requestDevicePreviewStream(previewId, {
          maxFps: previewPlatform === "ios" ? 15 : 4,
          maxWidth: 720,
          jpegQuality: 70,
        });
        if (disposed || abort.signal.aborted) return;
        if (!nextAccess.success || !nextAccess.url || !nextAccess.leaseId) {
          throw new Error(nextAccess.error ?? "无法打开模拟器画面");
        }
        const safeAccess: DevicePreviewStreamAccess = {
          ...nextAccess,
          controlMode: nextAccess.controlMode === "controller" ? "controller" : "view_only",
        };
        setAccess(safeAccess);
        let receivedFirstFrame = false;
        await consumeDevicePreviewStream(nextAccess.url, {
          signal: abort.signal,
          onFrame: (frame) => {
            if (disposed || abort.signal.aborted) return;
            const painter = painterRef.current;
            if (!painter) return;
            painter.enqueue(frame.sequence, frame.jpeg);
            if (!receivedFirstFrame) {
              receivedFirstFrame = true;
              retryAttempt = 0;
              setStreamStatus("streaming");
            }
          },
        });
        if (!disposed && !abort.signal.aborted) throw new Error("模拟器画面已断开");
      } catch (error) {
        if (disposed || abort.signal.aborted) return;
        const message = error instanceof Error ? error.message : "模拟器画面已断开";
        pointerStartRef.current = null;
        setAccess(null);
        setClaimingControl(false);
        setStreamStatus("error");
        setStreamError(message);
        schedule();
      }
    };

    const onVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") {
        stop();
        pointerStartRef.current = null;
        setAccess(null);
        setClaimingControl(false);
        setStreamStatus("waiting");
        return;
      }
      retryAttempt = 0;
      void connect();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    void connect();
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stop();
    };
  }, [previewError, previewId, previewPlatform, previewState, streamGeneration]);

  useEffect(() => {
    const relay = relayClientRef;
    const leaseId = access?.leaseId;
    if (!relay || !leaseId) return;
    return relay.onMessage((message) => {
      if (message.type !== "device_preview_control_revoked_push" || message.leaseId !== leaseId) {
        return;
      }
      pointerStartRef.current = null;
      setClaimingControl(false);
      setAccess((current) => {
        if (current?.leaseId !== leaseId) return current;
        return message.reason === "taken_over" ? { ...current, controlMode: "view_only" } : null;
      });
      if (message.reason === "taken_over") toast.info("控制权已由其他页面接管");
    });
  }, [access?.leaseId]);

  const currentAccess =
    preview?.state === "ready" && access?.previewId === preview.previewId ? access : null;
  const canControl =
    preview?.interactive === true &&
    streamStatus === "streaming" &&
    currentAccess?.controlMode === "controller";

  const sendInput = useCallback(
    async (input: DevicePreviewInput): Promise<boolean> => {
      const relay = relayClientRef;
      const leaseId = currentAccess?.leaseId;
      if (!relay || !leaseId || !canControl) return false;
      try {
        const result = await relay.sendDevicePreviewInput(leaseId, input);
        if (!result.success) {
          toast.error(result.error ?? "模拟器操作失败");
          return false;
        }
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "模拟器操作失败");
        return false;
      }
    },
    [canControl, currentAccess?.leaseId],
  );

  function pointForEvent(event: ReactPointerEvent<HTMLDivElement>) {
    const surface = surfaceRef.current;
    if (!surface || !frameSize) return null;
    const rect = surface.getBoundingClientRect();
    return normalizedPointInDeviceFrame(event.clientX, event.clientY, {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      frameWidth: frameSize.width,
      frameHeight: frameSize.height,
    });
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!canControl || event.button !== 0 || pointerStartRef.current) return;
    const point = pointForEvent(event);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerStartRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      startedAt: performance.now(),
      point,
    };
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (!canControl || !start || start.pointerId !== event.pointerId) return;
    event.preventDefault();
    const end = pointForEvent(event);
    if (!end) return;
    const gesture = devicePointerGesture({
      start: start.point,
      end,
      startClientX: start.clientX,
      startClientY: start.clientY,
      endClientX: event.clientX,
      endClientY: event.clientY,
      durationMs: performance.now() - start.startedAt,
    });
    void sendInput(gesture);
  }

  async function claimControl(): Promise<void> {
    const relay = relayClientRef;
    const leaseId = currentAccess?.leaseId;
    if (!relay || !leaseId || claimingControl || streamStatus !== "streaming") return;
    setClaimingControl(true);
    try {
      const result = await relay.claimDevicePreviewControl(leaseId);
      if (!result.success || result.controlMode !== "controller") {
        toast.error(result.error ?? "暂时无法取得控制权");
        return;
      }
      setAccess((current) =>
        current?.leaseId === leaseId ? { ...current, controlMode: "controller" } : current,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "暂时无法取得控制权");
    } finally {
      setClaimingControl(false);
    }
  }

  async function submitText(event: FormEvent): Promise<void> {
    event.preventDefault();
    const value = text;
    if (!value || sendingText) return;
    setSendingText(true);
    const sent = await sendInput({ kind: "text", text: value });
    if (sent) setText("");
    setSendingText(false);
  }

  async function retryConnection(): Promise<void> {
    if (preview?.state !== "failed" && preview?.state !== "disconnected") {
      setStreamGeneration((value) => value + 1);
      return;
    }
    const relay = relayClientRef;
    if (!relay) {
      toast.error("请先连接开发机");
      return;
    }
    const previousState = preview.state;
    useDevicePreviewStore.getState().setPreviewState(preview.previewId, "starting");
    try {
      const result = await relay.reconnectDevicePreview(preview.previewId);
      if (!result.success) {
        useDevicePreviewStore
          .getState()
          .setPreviewStateIf(preview.previewId, "starting", previousState);
        toast.error(result.error ?? "无法重新连接模拟器预览");
      }
    } catch (error) {
      useDevicePreviewStore
        .getState()
        .setPreviewStateIf(preview.previewId, "starting", previousState);
      toast.error(error instanceof Error ? error.message : "无法重新连接模拟器预览");
    }
  }

  if (!preview) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        {!listLoaded ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="加载中" />
        ) : (
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">这个预览已经不存在了。</p>
            <Button variant="outline" onClick={() => navigate("/sessions")}>
              返回
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-slot="device-preview-page"
      data-preview-id={preview.previewId}
      data-stream-status={streamStatus}
      data-control-mode={
        preview.interactive ? (currentAccess?.controlMode ?? "none") : "unavailable"
      }
    >
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b px-3 md:px-4">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          aria-label="返回"
          onClick={() => navigate("/sessions")}
        >
          <ArrowLeft aria-hidden="true" />
        </Button>
        <MonitorSmartphone className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{preview.name}</p>
          <p className="truncate text-xs text-muted-foreground">{preview.targetName}</p>
        </div>
        {preview.interactive &&
        streamStatus === "streaming" &&
        currentAccess?.controlMode === "view_only" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={claimingControl}
            onClick={() => void claimControl()}
            data-slot="device-preview-claim-control"
          >
            接管控制
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">
            {canControl ? "可操控" : streamStatus === "streaming" ? "仅查看" : "连接中"}
          </span>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col bg-muted/30 md:flex-row">
        <div
          className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3 md:p-6"
          data-slot="device-preview-viewport"
        >
          <div
            ref={surfaceRef}
            className={cn(
              "relative flex h-full w-full min-h-0 min-w-0 items-center justify-center overflow-hidden rounded-xl bg-black shadow-2xl",
              canControl && "cursor-pointer touch-none",
            )}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerMove={(event) => {
              if (pointerStartRef.current?.pointerId === event.pointerId) event.preventDefault();
            }}
            onPointerCancel={(event) => {
              if (pointerStartRef.current?.pointerId === event.pointerId) {
                pointerStartRef.current = null;
              }
            }}
            onLostPointerCapture={(event) => {
              if (pointerStartRef.current?.pointerId === event.pointerId) {
                pointerStartRef.current = null;
              }
            }}
            data-slot="device-preview-surface"
            data-control-enabled={canControl ? "true" : "false"}
          >
            <canvas
              ref={canvasRef}
              className="pointer-events-none h-full w-full object-contain"
              data-slot="device-preview-canvas"
            />
          </div>
          {streamStatus !== "streaming" ? (
            <div
              className="absolute inset-0 flex items-center justify-center bg-background/55 p-6 backdrop-blur-[1px]"
              data-slot="device-preview-stream-overlay"
              data-stream-status={streamStatus}
            >
              <div className="grid max-w-sm justify-items-center gap-3 text-center">
                {streamStatus === "error" ? (
                  <>
                    <p className="text-sm text-muted-foreground">{streamError}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void retryConnection()}
                      data-slot="device-preview-retry"
                    >
                      重新连接
                    </Button>
                  </>
                ) : (
                  <>
                    <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
                    <p className="text-sm text-muted-foreground">
                      {preview.state === "starting" ? "正在创建预览..." : "正在连接画面..."}
                    </p>
                  </>
                )}
              </div>
            </div>
          ) : null}
        </div>

        <aside className="shrink-0 border-t bg-card px-3 pt-3 pb-[max(theme(spacing.3),env(safe-area-inset-bottom))] md:w-72 md:border-l md:border-t-0 md:p-4">
          <div className="flex gap-2 md:grid md:grid-cols-3">
            <ControlButton
              control="home"
              label="主屏幕"
              disabled={!canControl}
              icon={<Home aria-hidden="true" />}
              onClick={() => void sendInput({ kind: "button", button: "home" })}
            />
            {preview.platform === "android" ? (
              <ControlButton
                control="back"
                label="返回"
                disabled={!canControl}
                icon={<Undo2 aria-hidden="true" />}
                onClick={() => void sendInput({ kind: "button", button: "back" })}
              />
            ) : null}
            <ControlButton
              control="orientation"
              label="旋转"
              disabled={!canControl || !frameSize}
              icon={<RotateCw aria-hidden="true" />}
              onClick={() =>
                void sendInput({
                  kind: "orientation",
                  orientation:
                    frameSize && frameSize.width > frameSize.height
                      ? "portrait"
                      : "landscape_right",
                })
              }
            />
          </div>

          <form className="mt-3 flex gap-2 md:mt-5" onSubmit={(event) => void submitText(event)}>
            <input
              value={text}
              onChange={(event) => setText(event.target.value)}
              disabled={!canControl || sendingText}
              maxLength={4096}
              placeholder="输入文字"
              aria-label="输入文字"
              data-slot="device-preview-text-input"
              className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            />
            <Button
              type="submit"
              size="icon"
              disabled={!canControl || !text || sendingText}
              aria-label="发送文字"
              data-slot="device-preview-send-text"
            >
              {sendingText ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Send aria-hidden="true" />
              )}
            </Button>
          </form>
        </aside>
      </div>
    </div>
  );
}

function ControlButton({
  control,
  label,
  icon,
  disabled,
  onClick,
}: {
  control: "home" | "back" | "orientation";
  label: string;
  icon: React.ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      className="h-11 min-w-0 flex-1 gap-1.5 px-2 md:h-auto md:flex-col md:py-3"
      disabled={disabled}
      onClick={onClick}
      data-slot="device-preview-control"
      data-control={control}
    >
      <span className="[&>svg]:size-4">{icon}</span>
      <span className="truncate text-xs">{label}</span>
    </Button>
  );
}
