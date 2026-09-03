import type { PreviewScope as WirePreviewScope } from "@dev-anywhere/shared";

/** Relay-issued wire scope for one committed client -> Proxy binding. */
export type PreviewScope = Readonly<WirePreviewScope>;

export function createPreviewScope(proxyId: string, bindingId: string): PreviewScope {
  if (proxyId.length === 0) throw new TypeError("PreviewScope proxyId must not be empty");
  if (bindingId.length === 0) throw new TypeError("PreviewScope bindingId must not be empty");
  return Object.freeze({ proxyId, bindingId });
}

export function samePreviewScope(left: PreviewScope, right: PreviewScope): boolean {
  return left === right || (left.proxyId === right.proxyId && left.bindingId === right.bindingId);
}
