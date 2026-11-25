import { ControlErrorCode } from "@dev-anywhere/shared";
import type { RelayClient } from "@/services/relay-client";

export async function requestRemoteFileUrlWithFallback(
  relay: Pick<RelayClient, "requestRemoteFileUrl">,
  sessionId: string,
  path: string,
  disposition: "inline" | "download",
  fallbackPath?: string,
) {
  const response = await relay.requestRemoteFileUrl(sessionId, path, disposition);
  if (
    fallbackPath &&
    !response.success &&
    (response.errorCode === ControlErrorCode.INVALID_PATH ||
      response.errorCode === ControlErrorCode.PATH_NOT_FOUND ||
      response.errorCode === ControlErrorCode.PATH_NOT_DIRECTORY)
  ) {
    const fallback = await relay.requestRemoteFileUrl(sessionId, fallbackPath, disposition);
    if (fallback.success && fallback.url) return { path: fallbackPath, response: fallback };
  }
  return { path, response };
}
