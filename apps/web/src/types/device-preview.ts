import type {
  DevicePreviewCapability as SharedDevicePreviewCapability,
  DevicePreviewSummary as SharedDevicePreviewSummary,
  DevicePreviewTarget as SharedDevicePreviewTarget,
} from "@dev-anywhere/shared";

export type DevicePreviewCapability = SharedDevicePreviewCapability;
export type DevicePreviewSummary = SharedDevicePreviewSummary;
export type DevicePreviewTarget = SharedDevicePreviewTarget;

export interface DevicePreviewSnapshot {
  epoch: string;
  revision: number;
  previews: DevicePreviewSummary[];
}
