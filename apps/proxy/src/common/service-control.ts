import { setLocalIpcEndpointPermissions } from "./local-ipc-endpoint.js";
import { connect, createServer, type Socket } from "node:net";
import { z } from "zod";

const CONTROL_VERSION = 1;
const REQUEST_LIMIT = 16 * 1024;
const RESPONSE_LIMIT = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const CONNECTION_LIMIT = 64;

// Service management is independent of the terminal/session wire protocol. Session details are
// observational only; adding a session state must not prevent stopping the service.
const serviceInfoSchema = z.object({
  config: z.object({
    profile: z.string().optional(),
    version: z.string(),
    autoUpdate: z.boolean(),
    relayName: z.string(),
    relayNameSource: z.enum(["cli", "profile", "env"]),
    relayUrl: z.string().optional(),
    relayUrlSource: z.enum(["env", "file", "none"]),
    relayTokenSource: z.enum(["env", "file", "none"]),
    hookPort: z.number(),
    hookPortSource: z.enum(["env", "file", "default"]),
  }),
  relay: z
    .object({
      connected: z.boolean(),
      proxyId: z.string(),
      reconnectAttempt: z.number(),
      queueDepth: z.number(),
    })
    .nullable(),
  sessions: z.array(
    z.object({
      id: z.string(),
      mode: z.enum(["pty", "json"]),
      state: z.string(),
      createdAt: z.string(),
      name: z.string().optional(),
      hasWorker: z.boolean(),
    }),
  ),
});

const serviceStatusSchema = z
  .object({
    pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    instanceId: z.string().min(1).max(128),
    profile: z.string().min(1).max(64),
    version: z.string().min(1).max(128),
    state: z.enum(["ready", "stopping"]),
    info: z.unknown().optional(),
  })
  .transform(({ info, ...status }) => {
    const details = serviceInfoSchema.safeParse(info);
    return { ...status, ...(details.success ? { info: details.data } : {}) };
  });

export type ServiceStatus = z.infer<typeof serviceStatusSchema>;
export type ServiceInfo = z.infer<typeof serviceInfoSchema>;
export type ServiceControlAction = "status" | "stop";

const requestSchema = z.object({
  version: z.literal(CONTROL_VERSION),
  action: z.enum(["status", "stop"]),
});
const responseSchema = z.union([
  z.object({ version: z.literal(CONTROL_VERSION), service: serviceStatusSchema }),
  z.object({ version: z.literal(CONTROL_VERSION), error: z.string() }),
]);

/** A missing endpoint is different from an unresponsive or incompatible service. */
export function requestServiceControl(
  socketPath: string,
  action: ServiceControlAction,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<ServiceStatus | null> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new TypeError("Invalid service control timeout"));
  }
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let settled = false;
    let received = Buffer.alloc(0);
    const finish = (error: Error | null, service: ServiceStatus | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(service);
    };
    const timer = setTimeout(
      () => finish(new Error(`Service control ${action} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ version: CONTROL_VERSION, action })}\n`);
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") finish(null);
      else finish(error);
    });
    socket.once("close", () => finish(new Error("Service control closed without a response")));
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (received.length + chunk.length > RESPONSE_LIMIT) {
        finish(new Error("Service control response exceeds the size limit"));
        return;
      }
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(10);
      if (newline < 0) return;
      try {
        if (
          received
            .subarray(newline + 1)
            .toString("utf8")
            .trim()
        ) {
          throw new Error("Unexpected additional service control response");
        }
        const response = responseSchema.parse(
          JSON.parse(received.subarray(0, newline).toString("utf8")),
        );
        if ("error" in response) finish(new Error(response.error));
        else finish(null, response.service);
      } catch (error) {
        finish(new Error("Invalid service control response", { cause: error }));
      }
    });
  });
}

export interface ServiceControlServerOptions {
  socketPath: string;
  getStatus(): ServiceStatus;
  onStop(): void;
}

export async function startServiceControl(
  options: ServiceControlServerOptions,
): Promise<{ close(): void }> {
  const sockets = new Set<Socket>();
  let stopping = false;
  let stopDispatched = false;
  const server = createServer((socket) => {
    if (sockets.size >= CONNECTION_LIMIT) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    let received = Buffer.alloc(0);
    let handled = false;
    const timer = setTimeout(() => socket.destroy(), REQUEST_TIMEOUT_MS);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      clearTimeout(timer);
      sockets.delete(socket);
    });
    const respond = (response: unknown, afterWrite?: () => void) => {
      const data = `${JSON.stringify(response)}\n`;
      if (Buffer.byteLength(data) > RESPONSE_LIMIT) {
        socket.end(
          `${JSON.stringify({ version: CONTROL_VERSION, error: "Service status exceeds the size limit" })}\n`,
        );
        return;
      }
      socket.end(data, () => afterWrite?.());
    };
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      if (received.length + chunk.length > REQUEST_LIMIT) {
        handled = true;
        socket.destroy();
        return;
      }
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(10);
      if (newline < 0) return;
      handled = true;
      try {
        if (
          received
            .subarray(newline + 1)
            .toString("utf8")
            .trim()
        ) {
          throw new Error("Only one service control command is permitted");
        }
        const request = requestSchema.parse(
          JSON.parse(received.subarray(0, newline).toString("utf8")),
        );
        const observed = options.getStatus();
        const status = serviceStatusSchema.parse(
          request.action === "stop" ? { ...observed, info: undefined } : observed,
        );
        if (request.action === "stop") stopping = true;
        respond(
          {
            version: CONTROL_VERSION,
            service: { ...status, state: stopping ? "stopping" : status.state },
          },
          request.action === "stop"
            ? () => {
                if (stopDispatched) return;
                stopDispatched = true;
                options.onStop();
              }
            : undefined,
        );
      } catch {
        respond({ version: CONTROL_VERSION, error: "Invalid service control request or status" });
      }
    });
  });
  const close = () => {
    server.close();
    for (const socket of sockets) socket.destroy();
  };
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(options.socketPath, () => {
      try {
        setLocalIpcEndpointPermissions(options.socketPath);
        server.off("error", onError);
        resolve();
      } catch (error) {
        close();
        reject(error);
      }
    });
  });
  return { close };
}
