import type { RelayControlMessage } from "@dev-anywhere/shared";
import {
  PreviewRouteRegistry,
  type PreviewRouteRegistryOptions,
} from "./preview-route-registry.js";

export const devicePreviewResponseByRequest = {
  device_preview_capability_request: "device_preview_capability_response",
  device_preview_targets_request: "device_preview_targets_response",
  device_preview_create_request: "device_preview_create_response",
  device_preview_list_request: "device_preview_list_response",
  device_preview_rename_request: "device_preview_rename_response",
  device_preview_reconnect_request: "device_preview_reconnect_response",
  device_preview_close_request: "device_preview_close_response",
} as const;

export type DevicePreviewRequestType = keyof typeof devicePreviewResponseByRequest;
export type DevicePreviewResponseType =
  (typeof devicePreviewResponseByRequest)[DevicePreviewRequestType];
export type DevicePreviewRequestMessage = Extract<
  RelayControlMessage,
  { type: DevicePreviewRequestType }
>;
export type DevicePreviewResponseMessage = Extract<
  RelayControlMessage,
  { type: DevicePreviewResponseType }
>;
const requestTypes = new Set<string>(Object.keys(devicePreviewResponseByRequest));
const responseTypes = new Set<string>(Object.values(devicePreviewResponseByRequest));

export function isDevicePreviewRequestMessage(
  message: RelayControlMessage,
): message is DevicePreviewRequestMessage {
  return requestTypes.has(message.type);
}

export function isDevicePreviewResponseMessage(
  message: RelayControlMessage,
): message is DevicePreviewResponseMessage {
  return responseTypes.has(message.type);
}

export class DevicePreviewRouteRegistry extends PreviewRouteRegistry<DevicePreviewResponseType> {
  constructor(options: PreviewRouteRegistryOptions = {}) {
    super({ label: "Device Preview", requestIdPrefix: "relay-device-preview" }, options);
  }
}
