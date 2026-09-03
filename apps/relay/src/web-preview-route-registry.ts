import type { RelayControlMessage } from "@dev-anywhere/shared";
import {
  PreviewRouteRegistry,
  type PreviewRouteRegistryOptions,
} from "./preview-route-registry.js";

export const webPreviewResponseByRequest = {
  preview_capability_request: "preview_capability_response",
  preview_static_inspect_request: "preview_static_inspect_response",
  preview_create_request: "preview_create_response",
  preview_list_request: "preview_list_response",
  preview_rename_request: "preview_rename_response",
  preview_reconnect_request: "preview_reconnect_response",
  preview_close_request: "preview_close_response",
} as const;

export type WebPreviewRequestType = keyof typeof webPreviewResponseByRequest;
export type WebPreviewResponseType = (typeof webPreviewResponseByRequest)[WebPreviewRequestType];
export type WebPreviewRequestMessage = Extract<
  RelayControlMessage,
  { type: WebPreviewRequestType }
>;
export type WebPreviewResponseMessage = Extract<
  RelayControlMessage,
  { type: WebPreviewResponseType }
>;
const requestTypes = new Set<string>(Object.keys(webPreviewResponseByRequest));
const responseTypes = new Set<string>(Object.values(webPreviewResponseByRequest));

export function isWebPreviewRequestMessage(
  message: RelayControlMessage,
): message is WebPreviewRequestMessage {
  return requestTypes.has(message.type);
}

export function isWebPreviewResponseMessage(
  message: RelayControlMessage,
): message is WebPreviewResponseMessage {
  return responseTypes.has(message.type);
}

export class WebPreviewRouteRegistry extends PreviewRouteRegistry<WebPreviewResponseType> {
  constructor(options: PreviewRouteRegistryOptions = {}) {
    super({ label: "Web Preview", requestIdPrefix: "relay-preview" }, options);
  }
}
