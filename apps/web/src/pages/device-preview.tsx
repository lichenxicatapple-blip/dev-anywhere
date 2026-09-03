import {
  ArrowLeft,
  ClipboardPaste,
  Home,
  Loader2,
  MonitorSmartphone,
  RotateCw,
  Undo2,
} from "lucide-react";
import {
  type CSSProperties,
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "@/components/toast";
import { relayClientRef } from "@/hooks/use-relay-setup";
import {
  clampedPointInDeviceFrame,
  normalizedPointInDeviceFrame,
} from "@/lib/device-preview-pointer";
import { cn } from "@/lib/utils";
import { LatestDevicePreviewFramePainter } from "@/services/device-preview-frame-painter";
import { DevicePreviewH264Player } from "@/services/device-preview-h264-player";
import {
  consumeDevicePreviewH264Stream,
  consumeDevicePreviewStream,
} from "@/services/device-preview-stream";
import {
  previewController,
  type ActiveDevicePreviewStreamAccess,
} from "@/services/preview-controller";
import { samePreviewScope } from "@/services/preview-scope";
import { SingleTouchController } from "@/services/single-touch-controller";
import { selectDevicePreviews, useDevicePreviewStore } from "@/stores/device-preview-store";
import {
  hasPendingPreviewOperation,
  usePreviewOperationStore,
} from "@/stores/preview-operation-store";

type StreamStatus = "waiting" | "connecting" | "streaming" | "error";
type FailActiveStream = (leaseId: string, error: unknown, reportError?: boolean) => void;

const H264_PLAYBACK_START_TIMEOUT_MS = 15_000;
const STREAM_STABLE_BACKOFF_RESET_MS = 10_000;
const DEVICE_SHELL_CLEARANCE_PX = {
  ios: 40,
  android: 28,
} as const;
const DEFAULT_DEVICE_FRAME_SIZE = {
  ios: { width: 390, height: 844 },
  android: { width: 412, height: 915 },
} as const;

export function DevicePreviewPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const preview = useDevicePreviewStore((state) =>
    selectDevicePreviews(state).find((candidate) => candidate.previewId === id),
  );
  const listLoaded = useDevicePreviewStore((state) => state.listLoaded);
  const previewScope = useDevicePreviewStore((state) => state.authoritative?.scope ?? null);
  const reconnecting = usePreviewOperationStore((state) =>
    hasPendingPreviewOperation(state, previewScope, "device", id, "reconnect"),
  );
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const painterRef = useRef<LatestDevicePreviewFramePainter | null>(null);
  const touchControllerRef = useRef<SingleTouchController | null>(null);
  const failActiveStreamRef = useRef<FailActiveStream>(() => {});
  const textRequestRef = useRef<symbol | null>(null);
  const claimRequestRef = useRef<symbol | null>(null);
  const [streamGeneration, setStreamGeneration] = useState(0);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("waiting");
  const [streamError, setStreamError] = useState<string | null>(null);
  const [access, setAccess] = useState<ActiveDevicePreviewStreamAccess | null>(null);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [text, setText] = useState("");
  const [textEntryOpen, setTextEntryOpen] = useState(false);
  const [sendingText, setSendingText] = useState(false);
  const [claimingControl, setClaimingControl] = useState(false);
  const previewId = preview?.previewId;
  const previewState = preview?.state;
  const previewPlatform = preview?.platform;

  const disposeTouchController = useCallback((): void => {
    const controller = touchControllerRef.current;
    touchControllerRef.current = null;
    controller?.dispose();
  }, []);

  useEffect(() => {
    if (previewPlatform !== "ios") {
      painterRef.current = null;
      setFrameSize(null);
      return;
    }
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
  }, [previewId, previewPlatform]);

  useEffect(() => {
    disposeTouchController();
    failActiveStreamRef.current = () => {};
    textRequestRef.current = null;
    claimRequestRef.current = null;
    setAccess(null);
    setSendingText(false);
    setClaimingControl(false);
    if (!previewId || previewState !== "ready") {
      if (previewState === "disconnected") {
        setStreamStatus("error");
        setStreamError("模拟器已断开");
      } else {
        setStreamStatus("waiting");
        setStreamError(null);
      }
      return;
    }
    const relay = relayClientRef;
    const scope = previewScope;
    if (!relay || !scope || !previewController.isActive(relay, scope)) {
      setStreamStatus("error");
      setStreamError("开发机连接已断开");
      return;
    }

    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let stableStreamTimer: ReturnType<typeof setTimeout> | null = null;
    let activeAbort: AbortController | null = null;
    let activePlayer: DevicePreviewH264Player | null = null;
    let activeLeaseId: string | null = null;
    let retryAttempt = 0;
    let failureHandled = false;

    const stop = (): void => {
      activeLeaseId = null;
      activeAbort?.abort();
      activeAbort = null;
      activePlayer?.destroy();
      activePlayer = null;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      if (stableStreamTimer) clearTimeout(stableStreamTimer);
      stableStreamTimer = null;
    };

    const markStreamStarted = (activeAccess: ActiveDevicePreviewStreamAccess): void => {
      setStreamStatus("streaming");
      if (stableStreamTimer) clearTimeout(stableStreamTimer);
      stableStreamTimer = setTimeout(() => {
        stableStreamTimer = null;
        if (
          disposed ||
          activeAccess.signal.aborted ||
          activeLeaseId !== activeAccess.leaseId ||
          !previewController.isActive(relay, scope)
        ) {
          return;
        }
        retryAttempt = 0;
      }, STREAM_STABLE_BACKOFF_RESET_MS);
    };

    const schedule = (): void => {
      if (
        disposed ||
        document.visibilityState === "hidden" ||
        !previewController.isActive(relay, scope)
      ) {
        return;
      }
      const delay = Math.min(5_000, 500 * 2 ** retryAttempt);
      retryAttempt += 1;
      retryTimer = setTimeout(() => void connect(), delay);
    };

    const connect = async (): Promise<void> => {
      disposeTouchController();
      stop();
      if (
        disposed ||
        document.visibilityState === "hidden" ||
        !previewController.isActive(relay, scope)
      ) {
        return;
      }
      failureHandled = false;
      painterRef.current?.reset();
      setFrameSize(null);
      setStreamStatus("connecting");
      setStreamError(null);
      setAccess(null);
      const abort = new AbortController();
      activeAbort = abort;
      try {
        const nextAccess = await previewController.requestDevicePreviewStream(
          scope,
          previewId,
          previewPlatform === "android"
            ? { format: "h264_annex_b" }
            : { format: "jpeg", maxFps: 15 },
          { signal: abort.signal },
        );
        if (
          disposed ||
          abort.signal.aborted ||
          !previewController.isActive(relay, scope) ||
          !nextAccess
        ) {
          return;
        }
        if (!nextAccess.success) {
          throw new Error(nextAccess.error);
        }
        const activeAccess: ActiveDevicePreviewStreamAccess = nextAccess;
        activeLeaseId = activeAccess.leaseId;
        setAccess(activeAccess);
        if (previewPlatform === "android") {
          const video = videoRef.current;
          if (!video) throw new Error("无法初始化 Android 模拟器播放器");
          let rejectPlayback!: (error: Error) => void;
          const playbackFailure = new Promise<never>((_resolve, reject) => {
            rejectPlayback = reject;
          });
          const playbackStartTimer = setTimeout(() => {
            rejectPlayback(new Error("Android 模拟器画面启动超时"));
          }, H264_PLAYBACK_START_TIMEOUT_MS);
          const failPlayback = (error: Error): void => {
            rejectPlayback(error instanceof Error ? error : new Error(String(error)));
          };
          const player = new DevicePreviewH264Player(video, {
            onStart: () => {
              clearTimeout(playbackStartTimer);
              if (
                disposed ||
                activeAccess.signal.aborted ||
                !previewController.isActive(relay, scope)
              ) {
                return;
              }
              markStreamStarted(activeAccess);
            },
            onError: failPlayback,
            onResyncRequired: failPlayback,
          });
          activePlayer = player;
          try {
            await Promise.race([
              consumeDevicePreviewH264Stream(activeAccess.url, {
                signal: activeAccess.signal,
                onSize: (size) => {
                  if (
                    !disposed &&
                    !activeAccess.signal.aborted &&
                    previewController.isActive(relay, scope)
                  ) {
                    setFrameSize(size);
                  }
                },
                onPacket: (packet) => {
                  if (
                    !disposed &&
                    !activeAccess.signal.aborted &&
                    previewController.isActive(relay, scope)
                  ) {
                    player.feed(packet);
                  }
                },
              }),
              playbackFailure,
            ]);
          } finally {
            clearTimeout(playbackStartTimer);
          }
          if (
            !disposed &&
            !activeAccess.signal.aborted &&
            previewController.isActive(relay, scope)
          ) {
            throw new Error("模拟器画面已断开");
          }
          return;
        }
        let receivedFirstFrame = false;
        await consumeDevicePreviewStream(activeAccess.url, {
          signal: activeAccess.signal,
          onFrame: (frame) => {
            if (
              disposed ||
              activeAccess.signal.aborted ||
              !previewController.isActive(relay, scope)
            ) {
              return;
            }
            const painter = painterRef.current;
            if (!painter) return;
            painter.enqueue(frame.sequence, frame.jpeg);
            if (!receivedFirstFrame) {
              receivedFirstFrame = true;
              markStreamStarted(activeAccess);
            }
          },
        });
        if (!disposed && !activeAccess.signal.aborted && previewController.isActive(relay, scope)) {
          throw new Error("模拟器画面已断开");
        }
      } catch (error) {
        if (disposed || abort.signal.aborted || !previewController.isActive(relay, scope)) return;
        failStream(error, false);
      }
    };

    const failStream = (error: unknown, reportError: boolean): void => {
      if (disposed || failureHandled || !previewController.isActive(relay, scope)) {
        return;
      }
      failureHandled = true;
      const message = error instanceof Error ? error.message : "模拟器画面已断开";
      disposeTouchController();
      stop();
      textRequestRef.current = null;
      claimRequestRef.current = null;
      setAccess(null);
      setSendingText(false);
      setClaimingControl(false);
      setStreamStatus("error");
      setStreamError(message);
      if (reportError) toast.error(message);
      schedule();
    };

    const failActiveStream: FailActiveStream = (leaseId, error, reportError = true): void => {
      if (leaseId !== activeLeaseId) return;
      failStream(error, reportError);
    };
    failActiveStreamRef.current = failActiveStream;

    const unsubscribeControlRevoked = relay.onMessage((message) => {
      if (
        message.type !== "device_preview_control_revoked_push" ||
        !samePreviewScope(message.scope, scope) ||
        message.leaseId !== activeLeaseId ||
        !previewController.isActive(relay, scope)
      ) {
        return;
      }
      claimRequestRef.current = null;
      setClaimingControl(false);
      if (message.reason === "taken_over") {
        textRequestRef.current = null;
        setSendingText(false);
        disposeTouchController();
        setAccess((current) =>
          current?.leaseId === message.leaseId ? { ...current, controlMode: "view_only" } : current,
        );
        toast.info("控制权已由其他页面接管");
        return;
      }
      const error = new Error(
        message.reason === "proxy_offline"
          ? "开发机连接已断开"
          : message.reason === "lease_expired"
            ? "模拟器画面连接已过期"
            : "模拟器画面已断开",
      );
      failActiveStream(message.leaseId, error, false);
    });

    const onVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") {
        disposeTouchController();
        stop();
        textRequestRef.current = null;
        claimRequestRef.current = null;
        setAccess(null);
        setSendingText(false);
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
      if (failActiveStreamRef.current === failActiveStream) failActiveStreamRef.current = () => {};
      unsubscribeControlRevoked();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      disposeTouchController();
      stop();
    };
  }, [
    disposeTouchController,
    previewId,
    previewPlatform,
    previewScope,
    previewState,
    streamGeneration,
  ]);

  useEffect(() => {
    touchControllerRef.current?.cancel();
  }, [frameSize?.height, frameSize?.width]);

  const currentAccess =
    preview?.state === "ready" &&
    access?.previewId === preview.previewId &&
    previewScope &&
    samePreviewScope(access.scope, previewScope)
      ? access
      : null;
  const canControl =
    preview?.interactive === true &&
    streamStatus === "streaming" &&
    currentAccess?.controlMode === "controller";

  useEffect(() => {
    disposeTouchController();
    const relay = relayClientRef;
    const activeAccess = currentAccess;
    if (!relay || !activeAccess || !canControl) return;

    const controller = new SingleTouchController({
      send: async (input) => {
        const result = await previewController.sendDevicePreviewInput(activeAccess, input);
        if (!result) throw new Error("模拟器控制连接已失效");
        if (!result.success) throw new Error(result.error);
      },
      onFailure: (error) => {
        if (touchControllerRef.current === controller) {
          failActiveStreamRef.current(activeAccess.leaseId, error);
        }
      },
    });
    touchControllerRef.current = controller;
    return () => {
      if (touchControllerRef.current === controller) touchControllerRef.current = null;
      controller.dispose();
    };
  }, [canControl, currentAccess, disposeTouchController]);

  const visibleFrameSize =
    frameSize ?? DEFAULT_DEVICE_FRAME_SIZE[preview?.platform === "android" ? "android" : "ios"];
  const shellClearance =
    DEVICE_SHELL_CLEARANCE_PX[preview?.platform === "android" ? "android" : "ios"];
  const frameAspectRatio = visibleFrameSize.width / visibleFrameSize.height;
  const frameOrientation =
    visibleFrameSize.width > visibleFrameSize.height ? "landscape" : "portrait";
  const landscapeFrameWidthLimit =
    frameOrientation === "landscape" ? `, ${visibleFrameSize.width}px` : "";
  const deviceShellStyle: CSSProperties = {
    aspectRatio: `${visibleFrameSize.width} / ${visibleFrameSize.height}`,
    width: `max(1px, min(calc(100cqw - ${shellClearance}px), calc(${(
      frameAspectRatio * 100
    ).toFixed(6)}cqh - ${(frameAspectRatio * shellClearance).toFixed(
      6,
    )}px)${landscapeFrameWidthLimit}))`,
  };

  useEffect(() => {
    if (!canControl) setTextEntryOpen(false);
  }, [canControl]);

  const sendInput = useCallback(
    async (input: DevicePreviewInput, reportError = true): Promise<boolean> => {
      const relay = relayClientRef;
      const activeAccess = currentAccess;
      if (!relay || !activeAccess || !canControl) return false;
      try {
        const result = await previewController.sendDevicePreviewInput(activeAccess, input);
        if (!result || !previewController.isActive(relay, activeAccess.scope)) return false;
        if (!result.success) {
          if (reportError) toast.error(result.error);
          return false;
        }
        return true;
      } catch (error) {
        if (activeAccess.signal.aborted || !previewController.isActive(relay, activeAccess.scope)) {
          return false;
        }
        if (reportError) {
          toast.error(error instanceof Error ? error.message : "模拟器操作失败");
        }
        return false;
      }
    },
    [canControl, currentAccess],
  );

  function pointForEvent(event: ReactPointerEvent<HTMLDivElement>, mode: "start" | "captured") {
    const surface = surfaceRef.current;
    if (!surface || !frameSize) return null;
    const rect = surface.getBoundingClientRect();
    const layout = {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      frameWidth: frameSize.width,
      frameHeight: frameSize.height,
    };
    return mode === "start"
      ? normalizedPointInDeviceFrame(event.clientX, event.clientY, layout)
      : clampedPointInDeviceFrame(event.clientX, event.clientY, layout);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!canControl || event.button !== 0) return;
    const point = pointForEvent(event, "start");
    if (!point) return;
    const controller = touchControllerRef.current;
    if (!controller?.begin(event.pointerId, point)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const point = pointForEvent(event, "captured");
    if (!point) return;
    if (touchControllerRef.current?.move(event.pointerId, point)) event.preventDefault();
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    const point = pointForEvent(event, "captured");
    if (point && touchControllerRef.current?.end(event.pointerId, point)) event.preventDefault();
  }

  function cancelPointer(event: ReactPointerEvent<HTMLDivElement>): void {
    touchControllerRef.current?.cancel(event.pointerId);
  }

  async function claimControl(): Promise<void> {
    const relay = relayClientRef;
    const activeAccess = currentAccess;
    if (!relay || !activeAccess || claimingControl || streamStatus !== "streaming") return;
    const request = Symbol("device-preview-control-claim");
    claimRequestRef.current = request;
    setClaimingControl(true);
    try {
      const result = await previewController.claimDevicePreviewControl(activeAccess);
      if (
        claimRequestRef.current !== request ||
        !result ||
        !previewController.isActive(relay, activeAccess.scope)
      ) {
        return;
      }
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setAccess((current) =>
        current?.leaseId === activeAccess.leaseId
          ? { ...current, controlMode: "controller" }
          : current,
      );
    } catch (error) {
      if (
        claimRequestRef.current !== request ||
        activeAccess.signal.aborted ||
        !previewController.isActive(relay, activeAccess.scope)
      ) {
        return;
      }
      toast.error(error instanceof Error ? error.message : "暂时无法取得控制权");
    } finally {
      if (claimRequestRef.current === request) {
        claimRequestRef.current = null;
        setClaimingControl(false);
      }
    }
  }

  async function submitText(event: FormEvent): Promise<void> {
    event.preventDefault();
    const value = text;
    if (!value || sendingText) return;
    const request = Symbol("device-preview-text-input");
    textRequestRef.current = request;
    setSendingText(true);
    const sent = await sendInput({ kind: "text", text: value });
    if (textRequestRef.current !== request) return;
    if (sent) {
      setText("");
      setTextEntryOpen(false);
    }
    textRequestRef.current = null;
    setSendingText(false);
  }

  function rotateDevice(): void {
    // The Manager releases the native pointer before rotating. Stop the matching browser gesture
    // immediately so later pointer events cannot cross the coordinate-space change.
    touchControllerRef.current?.cancel();
    void sendInput({
      kind: "orientation",
      orientation: frameSize && frameSize.width > frameSize.height ? "portrait" : "landscape_right",
    });
  }

  async function retryConnection(): Promise<void> {
    if (preview?.state !== "disconnected") {
      setStreamGeneration((value) => value + 1);
      return;
    }
    const relay = relayClientRef;
    const scope = previewController.getActiveScope();
    if (!relay || !scope) {
      toast.error("请先连接开发机");
      return;
    }
    try {
      const result = await previewController.reconnectDevicePreview(scope, preview.previewId);
      if (!result.success) {
        toast.error(result.error);
      }
    } catch (error) {
      if (!previewController.isActive(relay, scope)) return;
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
            <p className="text-sm text-muted-foreground">无法找到该预览</p>
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
          <p className="truncate text-xs text-muted-foreground">
            {preview.model} · {preview.platform === "ios" ? "iOS" : "Android"} {preview.osVersion}
          </p>
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

      <div className="min-h-0 flex-1 overflow-hidden bg-muted/30">
        <div
          className={cn(
            "grid h-full min-h-0 min-w-0 gap-3 p-3 md:gap-4 md:p-6",
            frameOrientation === "portrait"
              ? "grid-rows-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_auto] md:grid-rows-1"
              : "grid-rows-[minmax(0,1fr)_auto]",
          )}
          data-slot="device-preview-stage"
          data-orientation={frameOrientation}
        >
          <div
            className="relative flex min-h-0 min-w-0 items-center justify-center overflow-hidden [container-type:size]"
            data-slot="device-preview-viewport"
          >
            <div
              className={cn(
                "relative isolate shrink-0 transition-[width,aspect-ratio] duration-300 ease-out motion-reduce:transition-none [container-type:size]",
                preview.platform === "ios"
                  ? "[--device-screen-radius:clamp(22px,14cqmin,56px)] [--ios-rail:clamp(10px,4cqmin,16px)]"
                  : "[--device-screen-radius:clamp(14px,6.5cqw,38px)]",
              )}
              style={deviceShellStyle}
              data-slot="device-preview-device-shell"
              data-platform={preview.platform}
              data-orientation={frameOrientation}
            >
              <DeviceChrome platform={preview.platform} orientation={frameOrientation} />
              <div
                ref={surfaceRef}
                className={cn(
                  "relative z-10 flex h-full w-full min-h-0 min-w-0 items-center justify-center overflow-hidden rounded-[var(--device-screen-radius)] bg-black ring-1 ring-black",
                  canControl && "cursor-pointer",
                )}
                data-slot="device-preview-surface"
                data-control-enabled={canControl ? "true" : "false"}
              >
                {preview.platform === "android" ? (
                  <video
                    ref={videoRef}
                    className="pointer-events-none h-full w-full object-contain"
                    data-slot="device-preview-video"
                    muted
                    autoPlay
                    playsInline
                    disableRemotePlayback
                    onLoadedMetadata={(event) => {
                      const video = event.currentTarget;
                      if (video.videoWidth > 0 && video.videoHeight > 0) {
                        setFrameSize({ width: video.videoWidth, height: video.videoHeight });
                      }
                    }}
                    onResize={(event) => {
                      const video = event.currentTarget;
                      if (video.videoWidth > 0 && video.videoHeight > 0) {
                        setFrameSize({ width: video.videoWidth, height: video.videoHeight });
                      }
                    }}
                  />
                ) : (
                  <canvas
                    ref={canvasRef}
                    className="pointer-events-none h-full w-full object-contain"
                    data-slot="device-preview-canvas"
                  />
                )}
              </div>
              <div
                className={cn(
                  "absolute inset-0 z-20 select-none rounded-[var(--device-screen-radius)]",
                  canControl ? "touch-none cursor-pointer" : "pointer-events-none",
                )}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={cancelPointer}
                onLostPointerCapture={cancelPointer}
                onContextMenu={(event) => {
                  if (canControl) event.preventDefault();
                }}
                data-slot="device-preview-input-surface"
                data-control-enabled={canControl ? "true" : "false"}
                aria-hidden="true"
              />
            </div>
            {streamStatus !== "streaming" ? (
              <div
                className="absolute inset-0 z-30 flex items-center justify-center bg-background/55 p-6 backdrop-blur-[1px]"
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
                        disabled={reconnecting}
                        onClick={() => void retryConnection()}
                        data-slot="device-preview-retry"
                      >
                        {reconnecting ? (
                          <Loader2 className="size-4 animate-spin" aria-hidden />
                        ) : null}
                        {reconnecting ? "正在重新连接" : "重新连接"}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
                      <p className="text-sm text-muted-foreground">正在连接画面...</p>
                    </>
                  )}
                </div>
              </div>
            ) : null}
          </div>

          <div
            className="relative z-20 flex min-w-0 items-center justify-center pb-[max(0px,env(safe-area-inset-bottom))] md:pb-0"
            data-slot="device-preview-control-dock"
            data-orientation={frameOrientation}
            role="group"
            aria-label="模拟器控制"
          >
            <div
              className={cn(
                "flex max-w-full items-center gap-1 rounded-full border border-border/70 bg-card/85 p-1.5 shadow-xl ring-1 ring-black/5 backdrop-blur-xl",
                frameOrientation === "portrait" && "md:flex-col",
              )}
            >
              <DeviceControlButton
                control="home"
                label="主屏幕"
                disabled={!canControl}
                icon={<Home aria-hidden="true" />}
                tooltipSide={frameOrientation === "portrait" ? "left" : "top"}
                onClick={() => void sendInput({ kind: "button", button: "home" })}
              />
              {preview.platform === "android" ? (
                <DeviceControlButton
                  control="back"
                  label="返回"
                  disabled={!canControl}
                  icon={<Undo2 aria-hidden="true" />}
                  tooltipSide={frameOrientation === "portrait" ? "left" : "top"}
                  onClick={() => void sendInput({ kind: "button", button: "back" })}
                />
              ) : null}
              <DeviceControlButton
                control="orientation"
                label="旋转"
                disabled={!canControl || !frameSize}
                icon={<RotateCw aria-hidden="true" />}
                tooltipSide={frameOrientation === "portrait" ? "left" : "top"}
                onClick={rotateDevice}
              />

              <span
                className={cn(
                  "mx-0.5 h-6 w-px shrink-0 bg-border/80",
                  frameOrientation === "portrait" && "md:mx-0 md:h-px md:w-6",
                )}
                aria-hidden="true"
              />

              <Popover
                open={textEntryOpen}
                onOpenChange={(open) => {
                  if (!open || canControl) setTextEntryOpen(open);
                }}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={cn(
                          "size-11 rounded-full text-muted-foreground hover:text-foreground",
                          textEntryOpen && "bg-accent text-foreground",
                        )}
                        disabled={!canControl}
                        aria-label="粘贴文字"
                        aria-expanded={textEntryOpen}
                        aria-controls="device-preview-text-form"
                        data-slot="device-preview-text-toggle"
                      >
                        <ClipboardPaste aria-hidden="true" />
                      </Button>
                    </PopoverTrigger>
                  </TooltipTrigger>
                  <TooltipContent
                    side={frameOrientation === "portrait" ? "left" : "top"}
                    sideOffset={10}
                    hideArrow
                  >
                    粘贴文字
                  </TooltipContent>
                </Tooltip>
                <PopoverContent
                  side={frameOrientation === "portrait" ? "left" : "top"}
                  align="center"
                  sideOffset={12}
                  className="w-[min(20rem,calc(100vw-1.5rem))] rounded-2xl bg-card/95 p-2 shadow-2xl backdrop-blur-xl"
                >
                  <form
                    id="device-preview-text-form"
                    className="flex items-end gap-2"
                    data-slot="device-preview-text-form"
                    onSubmit={(event) => void submitText(event)}
                  >
                    <textarea
                      value={text}
                      onChange={(event) => setText(event.target.value)}
                      disabled={!canControl || sendingText}
                      maxLength={4096}
                      rows={3}
                      placeholder="粘贴文字"
                      aria-label="粘贴文字"
                      data-slot="device-preview-text-input"
                      className="min-h-20 min-w-0 flex-1 resize-none rounded-xl border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 md:text-sm"
                    />
                    <Button
                      type="submit"
                      size="icon"
                      className="size-10 rounded-xl"
                      disabled={!canControl || !text || sendingText}
                      aria-label="粘贴"
                      data-slot="device-preview-send-text"
                    >
                      {sendingText ? (
                        <Loader2 className="animate-spin" aria-hidden="true" />
                      ) : (
                        <ClipboardPaste aria-hidden="true" />
                      )}
                    </Button>
                  </form>
                </PopoverContent>
              </Popover>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DeviceControlButton({
  control,
  label,
  icon,
  disabled,
  tooltipSide,
  onClick,
}: {
  control: "home" | "back" | "orientation";
  label: string;
  icon: React.ReactNode;
  disabled: boolean;
  tooltipSide: "left" | "top";
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 rounded-full text-muted-foreground hover:text-foreground"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          data-slot="device-preview-control"
          data-control={control}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent
        side={tooltipSide}
        sideOffset={10}
        hideArrow
        className="border border-border/80 bg-card/95 px-2.5 py-1 text-muted-foreground shadow-sm backdrop-blur"
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function DeviceChrome({
  platform,
  orientation,
}: {
  platform: "ios" | "android";
  orientation: "portrait" | "landscape";
}) {
  const portrait = orientation === "portrait";

  if (platform === "ios") {
    return (
      <div
        aria-hidden="true"
        data-slot="device-preview-device-chrome"
        data-platform="ios"
        data-orientation={orientation}
        className={cn(
          "pointer-events-none absolute -inset-[var(--ios-rail)] z-0 select-none rounded-[calc(var(--device-screen-radius)+var(--ios-rail))] border border-black/85 bg-[#202024] ring-1 ring-black/30",
          "shadow-[inset_1px_1px_0_rgba(255,255,255,0.16),inset_-1px_-1px_0_rgba(0,0,0,0.72)]",
        )}
      >
        <span className="absolute inset-[2px] rounded-[calc(var(--device-screen-radius)+var(--ios-rail)-2px)] ring-1 ring-inset ring-white/[0.05]" />

        {portrait ? (
          <>
            <span className="absolute -left-[4px] top-[16%] h-[clamp(12px,4%,22px)] w-[4px] rounded-l-[3px] border border-r-0 border-black/70 bg-[#343439] shadow-[inset_1px_0_0_rgba(255,255,255,0.14)]" />
            <span className="absolute -left-[4px] top-[23%] h-[clamp(24px,7%,42px)] w-[4px] rounded-l-[3px] border border-r-0 border-black/70 bg-[#343439] shadow-[inset_1px_0_0_rgba(255,255,255,0.14)]" />
            <span className="absolute -left-[4px] top-[32%] h-[clamp(24px,7%,42px)] w-[4px] rounded-l-[3px] border border-r-0 border-black/70 bg-[#343439] shadow-[inset_1px_0_0_rgba(255,255,255,0.14)]" />
            <span className="absolute -right-[4px] top-[28%] h-[clamp(36px,12%,64px)] w-[4px] rounded-r-[3px] border border-l-0 border-black/70 bg-[#343439] shadow-[inset_-1px_0_0_rgba(255,255,255,0.14)]" />
          </>
        ) : (
          <>
            <span className="absolute -top-[4px] left-[16%] h-[4px] w-[clamp(12px,4%,22px)] rounded-t-[3px] border border-b-0 border-black/70 bg-[#343439] shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]" />
            <span className="absolute -top-[4px] left-[23%] h-[4px] w-[clamp(24px,7%,42px)] rounded-t-[3px] border border-b-0 border-black/70 bg-[#343439] shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]" />
            <span className="absolute -top-[4px] left-[32%] h-[4px] w-[clamp(24px,7%,42px)] rounded-t-[3px] border border-b-0 border-black/70 bg-[#343439] shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]" />
            <span className="absolute -bottom-[4px] left-[28%] h-[4px] w-[clamp(36px,12%,64px)] rounded-b-[3px] border border-t-0 border-black/70 bg-[#343439] shadow-[inset_0_-1px_0_rgba(255,255,255,0.14)]" />
          </>
        )}
      </div>
    );
  }

  return (
    <div
      aria-hidden="true"
      data-slot="device-preview-device-chrome"
      data-platform="android"
      data-orientation={orientation}
      className={cn(
        "pointer-events-none absolute -inset-[9px] z-0 select-none rounded-[calc(var(--device-screen-radius)+9px)] border border-black/70 bg-[linear-gradient(145deg,#68717a_0%,#22272d_22%,#08090b_58%,#454c55_100%)] ring-1 ring-white/15",
      )}
    >
      <span
        className={cn(
          "absolute rounded-full bg-white/25 shadow-sm",
          portrait
            ? "left-1/2 top-[3px] h-px w-[14%] -translate-x-1/2"
            : "left-[3px] top-1/2 h-[14%] w-px -translate-y-1/2",
        )}
      />

      {portrait ? (
        <>
          <span className="absolute -right-[4px] top-[20%] h-[14%] min-h-7 w-[3px] rounded-r-sm bg-slate-500 shadow-sm" />
          <span className="absolute -right-[4px] top-[38%] h-[9%] min-h-4 w-[3px] rounded-r-sm bg-slate-400 shadow-sm" />
        </>
      ) : (
        <>
          <span className="absolute -top-[4px] left-[20%] h-[3px] w-[14%] min-w-7 rounded-t-sm bg-slate-500 shadow-sm" />
          <span className="absolute -top-[4px] left-[38%] h-[3px] w-[9%] min-w-4 rounded-t-sm bg-slate-400 shadow-sm" />
        </>
      )}
    </div>
  );
}
