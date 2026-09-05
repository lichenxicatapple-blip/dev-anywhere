import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { unlinkIfPresent } from "./safe-unlink.js";

export function isNamedPipeEndpoint(endpoint: string): boolean {
  return /^\\\\[.?]\\pipe\\/i.test(endpoint);
}

export function prepareLocalIpcEndpoint(endpoint: string): void {
  if (!isNamedPipeEndpoint(endpoint)) mkdirSync(dirname(endpoint), { recursive: true });
}

export function setLocalIpcEndpointPermissions(endpoint: string): void {
  // Node uses the Windows pipe DACL; chmod is a filesystem operation, not a pipe ACL setter.
  // Do not enable readableAll/writableAll. Listeners must not send data before a client writes.
  if (!isNamedPipeEndpoint(endpoint)) chmodSync(endpoint, 0o600);
}

export function removeLocalIpcEndpoint(endpoint: string): void {
  // Windows removes the pipe when its final handle closes. Unlink cannot remove a pipe.
  if (!isNamedPipeEndpoint(endpoint)) unlinkIfPresent(endpoint);
}

/** A cheap scan filter, not a liveness check. Named pipes must always be probed by connecting. */
export function localIpcEndpointMayExist(endpoint: string): boolean {
  return isNamedPipeEndpoint(endpoint) || existsSync(endpoint);
}
