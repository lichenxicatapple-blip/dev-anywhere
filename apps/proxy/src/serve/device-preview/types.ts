import type {
  DevicePreviewCapability,
  DevicePreviewInput,
  DevicePreviewSummary,
  DevicePreviewTarget,
} from "@dev-anywhere/shared";

export interface DevicePreviewFrame {
  jpeg: Buffer;
  width: number;
  height: number;
}

/** Adapter boundary kept separate from the Relay wire protocol while that protocol evolves. */
export interface DevicePreviewBackend {
  inspectCapabilities(refreshPath?: boolean): Promise<DevicePreviewCapability>;
  discoverTargets(refresh?: boolean): Promise<DevicePreviewTarget[]>;
  capture(
    targetId: string,
    signal: AbortSignal,
    onFrame: (frame: DevicePreviewFrame) => void | Promise<void>,
  ): Promise<void>;
  sendInput(targetId: string, input: DevicePreviewInput, signal?: AbortSignal): Promise<void>;
  /** Release helper/input resources for an idle target without stopping the simulator itself. */
  releaseTarget?(targetId: string): void;
  dispose(): void | Promise<void>;
}

export interface DevicePreviewStreamTransport {
  sendFrame(streamId: string, frameSequence: number, jpeg: Buffer): void | Promise<void>;
  sendComplete(payload: {
    streamId: string;
    leaseId: string;
    previewId: string;
    success: boolean;
    error?: string;
  }): void;
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

export interface DevicePreviewStreamStart {
  streamId: string;
  leaseId: string;
  previewId: string;
  maxFps?: number;
  maxWidth?: number;
  jpegQuality?: number;
}

export interface DevicePreviewStreamStarted {
  previewId: string;
  streamId: string;
  leaseId: string;
  width?: number;
  height?: number;
}
