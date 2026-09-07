import type { Socket } from "node:net";
import { z } from "zod";
import { RelayControlSchema, type RelayControlMessage } from "@dev-anywhere/shared";
import { LineBuffer } from "./line-buffer.js";

// Independent of the npm version: compatible Serve upgrades reconnect to the same runtime.
export const PREVIEW_WORKER_PROTOCOL_VERSION = 1;

const requestTypes = [
  "preview_capability_request",
  "preview_static_inspect_request",
  "preview_create_request",
  "preview_list_request",
  "preview_rename_request",
  "preview_reconnect_request",
  "preview_close_request",
  "device_preview_capability_request",
  "device_preview_targets_request",
  "device_preview_create_request",
  "device_preview_list_request",
  "device_preview_rename_request",
  "device_preview_reconnect_request",
  "device_preview_close_request",
  "device_preview_stream_start",
  "device_preview_stream_stop",
  "device_preview_input_revoke",
  "device_preview_input",
] as const;
export type PreviewControlRequest = Extract<
  RelayControlMessage,
  { type: (typeof requestTypes)[number] }
>;
const requests = new Set<string>(requestTypes);
export function isPreviewControlRequest(
  message: RelayControlMessage,
): message is PreviewControlRequest {
  return requests.has(message.type);
}

export const PreviewWorkerRelaySchema = z.object({
  relayUrl: z.string().min(1),
  proxyId: z.string().min(1),
  token: z.string().optional(),
  connectionId: z.string().min(1).nullable(),
});
export type PreviewWorkerRelay = z.infer<typeof PreviewWorkerRelaySchema>;

export const PreviewWorkerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("serve_preview_hello"),
    protocolVersion: z.number().int(),
    profile: z.string(),
  }),
  z.object({
    type: z.literal("preview_worker_hello"),
    protocolVersion: z.number().int(),
    profile: z.string(),
    pid: z.number().int().positive(),
  }),
  z.object({ type: z.literal("preview_worker_configure"), relay: PreviewWorkerRelaySchema }),
  z.object({
    type: z.literal("preview_worker_request"),
    message: RelayControlSchema.refine(isPreviewControlRequest),
  }),
  z.object({
    type: z.literal("preview_worker_event"),
    message: RelayControlSchema.refine(
      (message) =>
        !isPreviewControlRequest(message) &&
        (message.type.startsWith("preview_") || message.type.startsWith("device_preview_")),
    ),
  }),
  z.object({ type: z.literal("preview_worker_error"), error: z.string() }),
]);
export type PreviewWorkerMessage = z.infer<typeof PreviewWorkerMessageSchema>;

export function writePreviewWorkerMessage(socket: Socket, message: PreviewWorkerMessage): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

export function readPreviewWorkerMessages(
  socket: Socket,
  onMessage: (message: PreviewWorkerMessage) => void,
  onError: (error: Error) => void,
): void {
  const lines = new LineBuffer();
  socket.pipe(lines);
  lines.on("data", (line: Buffer) => {
    if (socket.destroyed) return;
    try {
      onMessage(PreviewWorkerMessageSchema.parse(JSON.parse(line.toString())));
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
      socket.destroy();
    }
  });
  socket.once("close", () => {
    socket.unpipe(lines);
    lines.destroy();
  });
}
