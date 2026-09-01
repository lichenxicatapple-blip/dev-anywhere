import type {
  DevicePreviewCapability as SharedDevicePreviewCapability,
  DevicePreviewInput as SharedDevicePreviewInput,
  DevicePreviewSummary as SharedDevicePreviewSummary,
  DevicePreviewTarget as SharedDevicePreviewTarget,
} from "@dev-anywhere/shared";

export type DevicePreviewCapability = SharedDevicePreviewCapability;
export type DevicePreviewInput = SharedDevicePreviewInput;
export type DevicePreviewSummary = SharedDevicePreviewSummary;
export type DevicePreviewTarget = SharedDevicePreviewTarget;

export interface DevicePreviewSnapshot {
  epoch: string;
  revision: number;
  previews: DevicePreviewSummary[];
}

export function startingDevicePreview(
  previewId: string,
  target: DevicePreviewTarget,
  now = Date.now(),
): DevicePreviewSummary {
  return {
    previewId,
    name: target.name,
    platform: target.platform,
    targetId: target.targetId,
    targetName: target.name,
    state: "starting",
    interactive: target.interactive,
    createdAt: now,
    updatedAt: now,
  };
}
