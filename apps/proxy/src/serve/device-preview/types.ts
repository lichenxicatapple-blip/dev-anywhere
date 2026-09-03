import type {
  ControlMessage,
  DevicePreviewCapability,
  DevicePreviewInput,
  DevicePreviewStreamFormat,
  DevicePreviewStreamProfile,
  DevicePreviewSummary,
  DevicePreviewTarget,
} from "@dev-anywhere/shared";

type WithoutType<T> = T extends unknown ? Omit<T, "type"> : never;
type DevicePreviewStreamCompletePayload = WithoutType<
  ControlMessage<"device_preview_stream_complete">
>;

export interface DevicePreviewJpegFrame {
  format: "jpeg";
  jpeg: Buffer;
}

export interface DevicePreviewH264Packet {
  format: "h264_annex_b";
  kind: "configuration" | "frame";
  keyframe: boolean;
  durationMs: number;
  data: Buffer;
}

export type DevicePreviewFrame = DevicePreviewJpegFrame | DevicePreviewH264Packet;

/** Domain adapter boundary; Relay transport concerns stay outside device integrations. */
export interface DevicePreviewBackend {
  inspectCapabilities(refreshPath?: boolean): Promise<DevicePreviewCapability>;
  discoverTargets(refresh?: boolean): Promise<DevicePreviewTarget[]>;
  capture(
    targetId: string,
    signal: AbortSignal,
    onFrame: (frame: DevicePreviewFrame) => void | Promise<void>,
  ): Promise<void>;
  requestKeyframe(targetId: string): Promise<void>;
  sendInput(targetId: string, input: DevicePreviewInput, signal: AbortSignal): Promise<void>;
  /** Best-effort release for an active or partially completed touch gesture. */
  releaseInput(targetId: string): void | Promise<void>;
  /** Release helper/input resources for an idle target without stopping the simulator itself. */
  releaseTarget(targetId: string): void;
  dispose(): void | Promise<void>;
}

export interface DevicePreviewStreamTransport {
  sendFrame(streamId: string, frameSequence: number, jpeg: Buffer): void | Promise<void>;
  sendH264Packet(
    streamId: string,
    packetSequence: number,
    packet: Pick<DevicePreviewH264Packet, "kind" | "keyframe" | "durationMs" | "data">,
  ): void | Promise<void>;
  sendComplete(payload: DevicePreviewStreamCompletePayload): void;
}

export type DevicePreviewManagerEvent =
  | {
      type: "state";
      epoch: string;
      revision: number;
      preview: DevicePreviewSummary;
    }
  | {
      type: "removed";
      epoch: string;
      revision: number;
      previewId: string;
    };

export interface DevicePreviewSnapshot {
  epoch: string;
  revision: number;
  previews: DevicePreviewSummary[];
}

export type DevicePreviewStreamStart = {
  streamId: string;
  leaseId: string;
  previewId: string;
} & DevicePreviewStreamProfile;

interface DevicePreviewStreamStartedBase {
  previewId: string;
  streamId: string;
  leaseId: string;
  format: DevicePreviewStreamFormat;
}

export type DevicePreviewStreamStarted = DevicePreviewStreamStartedBase &
  ({ width: number; height: number } | { width?: never; height?: never });
