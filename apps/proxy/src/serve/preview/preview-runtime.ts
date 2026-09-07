import { serializeControl } from "@dev-anywhere/shared";
import type {
  PreviewWorkerRelay,
  PreviewControlRequest,
} from "../../ipc/preview-worker-protocol.js";
import { PreviewManager } from "./preview-manager.js";
import { DevicePreviewManager } from "../device-preview/device-preview-manager.js";
import { DefaultDevicePreviewBackend } from "../device-preview/default-device-preview-backend.js";
import { DevicePreviewStreamConnection } from "../device-preview/device-preview-stream-connection.js";
import type { DevicePreviewBackend } from "../device-preview/types.js";
import { PreviewControlRouter } from "./preview-control-router.js";

type WebOptions = ConstructorParameters<typeof PreviewManager>[0];

/** Owns resources, not the Serve connection. Detaching must never close a web tunnel. */
export class PreviewRuntime {
  readonly web: PreviewManager;
  readonly device: DevicePreviewManager;
  private readonly router: PreviewControlRouter;
  private stream?: DevicePreviewStreamConnection;
  private relay?: PreviewWorkerRelay;

  constructor(options: {
    web: Omit<WebOptions, "onEvent">;
    backend?: DevicePreviewBackend;
    send: (message: string) => void;
  }) {
    const send = options.send;
    this.web = new PreviewManager({
      ...options.web,
      onEvent: (event) =>
        send(
          serializeControl(
            event.type === "state"
              ? {
                  type: "preview_state_event",
                  epoch: event.epoch,
                  revision: event.revision,
                  preview: event.preview,
                }
              : {
                  type: "preview_removed_event",
                  epoch: event.epoch,
                  revision: event.revision,
                  previewId: event.previewId,
                },
          ),
        ),
    });
    this.device = new DevicePreviewManager({
      backend: options.backend ?? new DefaultDevicePreviewBackend(),
      streamTransport: {
        sendFrame: (id, seq, frame) =>
          this.stream
            ? this.stream.sendFrame(id, seq, frame)
            : Promise.reject(new Error("设备画面连接不可用")),
        sendH264Packet: (id, seq, packet) =>
          this.stream
            ? this.stream.sendH264Packet(id, seq, packet)
            : Promise.reject(new Error("设备画面连接不可用")),
        sendComplete: (payload) =>
          send(serializeControl({ type: "device_preview_stream_complete", ...payload })),
      },
      onEvent: (event) =>
        send(
          serializeControl(
            event.type === "state"
              ? {
                  type: "device_preview_state_event",
                  epoch: event.epoch,
                  revision: event.revision,
                  preview: event.preview,
                }
              : {
                  type: "device_preview_removed_event",
                  epoch: event.epoch,
                  revision: event.revision,
                  previewId: event.previewId,
                },
          ),
        ),
    });
    this.router = new PreviewControlRouter({
      relaySend: send,
      previewManager: this.web,
      devicePreviewManager: this.device,
    });
  }

  configure(relay: PreviewWorkerRelay): void {
    const previous = this.relay;
    const replaceStream =
      !previous ||
      previous.relayUrl !== relay.relayUrl ||
      previous.proxyId !== relay.proxyId ||
      previous.token !== relay.token;
    if (!replaceStream && previous.connectionId === relay.connectionId) return;
    this.disconnect();
    if (replaceStream) {
      this.stream?.close();
      this.stream = new DevicePreviewStreamConnection({
        ...relay,
        onFlow: (streamId, paused, resyncRequired) =>
          this.device.setFlowPaused(streamId, paused, resyncRequired),
      });
    }
    this.relay = { ...relay };
    if (relay.connectionId) this.stream?.register(relay.connectionId);
  }

  /** Queue admission and replies belong to one attachment/configuration; resource events do not.
   * Once a handler starts, it finishes normally and keeps its result in the shared journal. */
  bindConnection(
    isCurrent: () => boolean,
    reply: (message: string) => void,
  ): {
    configure(relay: PreviewWorkerRelay): void;
    handle(message: PreviewControlRequest): Promise<void>;
  } {
    let generation = 0;
    let router: PreviewControlRouter | undefined;
    return {
      configure: (relay) => {
        if (!isCurrent()) return;
        const configuredGeneration = ++generation;
        this.configure(relay);
        router = this.router.bindReply((message) => {
          if (isCurrent() && generation === configuredGeneration) reply(message);
        });
      },
      handle: (message) => {
        const receivedGeneration = generation;
        const receivedRouter = router;
        return Promise.resolve().then(() => {
          if (isCurrent() && generation === receivedGeneration) {
            return receivedRouter?.handle(message);
          }
        });
      },
    };
  }

  disconnect(): void {
    this.stream?.disconnectMain();
    this.device.disconnectTransport();
    if (this.relay) this.relay = { ...this.relay, connectionId: null };
  }

  get empty(): boolean {
    return this.web.list().previews.length === 0 && this.device.list().previews.length === 0;
  }

  async shutdown(): Promise<void> {
    this.stream?.close();
    await Promise.all([this.web.shutdown(), this.device.shutdown()]);
  }
}
