import type { PreviewScope, RelayControlMessage } from "@dev-anywhere/shared";

/** Preserve response data after validation while replacing Relay-owned routing fields. */
export function rewriteForwardedControl(
  validatedRaw: string,
  relayFields: {
    type: RelayControlMessage["type"];
    requestId?: string;
    scope?: PreviewScope;
  },
): string {
  const message = JSON.parse(validatedRaw) as Record<string, unknown>;
  // Responses without a request ID or scope must not inherit either from unknown metadata.
  delete message.requestId;
  delete message.scope;
  return JSON.stringify({ ...message, ...relayFields });
}
