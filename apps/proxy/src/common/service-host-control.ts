import { connect, createServer, type Socket } from "node:net";
import { z } from "zod";
import { setLocalIpcEndpointPermissions } from "./local-ipc-endpoint.js";
import { parseServiceCommandResult, type ServiceCommandResult } from "./service-command-result.js";

const VERSION = 1;
const REQUEST_LIMIT = 16 * 1024;
const RESPONSE_LIMIT = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 90_000;
const requestSchema = z
  .object({
    version: z.literal(VERSION),
    profile: z.string().min(1).max(64),
    action: z.enum(["start", "stop", "restart", "probe"]),
    intent: z.enum(["explicit", "recover"]).optional(),
    relay: z.string().min(1).max(128).optional(),
    recoveryToken: z.string().min(1).max(128).optional(),
  })
  .strict();
export type ServiceHostRequest = Omit<z.infer<typeof requestSchema>, "version" | "profile">;
type HostResult = ServiceCommandResult | { status: "host"; pid: number };
const responseSchema = z.object({
  version: z.literal(VERSION),
  profile: z.string(),
  result: z.unknown(),
});

/** Missing host permits local mode; an unavailable or incompatible host never does. */
export function requestServiceHost(
  endpoint: string,
  profile: string,
  request: ServiceHostRequest,
  timeoutMs = request.action === "probe" ? 2_000 : COMMAND_TIMEOUT_MS,
): Promise<HostResult | null> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    return Promise.reject(new TypeError("Invalid system service timeout"));
  const payload = requestSchema.parse({ ...request, version: VERSION, profile });
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let settled = false;
    let received = Buffer.alloc(0);
    const finish = (error: Error | null, result: HostResult | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(
      () => finish(new Error("System service command timed out")),
      timeoutMs,
    );
    socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? null : error);
    });
    socket.once("close", () => finish(new Error("System service closed without a response")));
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (received.length + chunk.length > RESPONSE_LIMIT) {
        finish(new Error("System service response exceeds the size limit"));
        return;
      }
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(10);
      if (newline < 0) return;
      try {
        if (
          received
            .subarray(newline + 1)
            .toString()
            .trim()
        )
          throw new Error("Extra response");
        const response = responseSchema.parse(JSON.parse(received.subarray(0, newline).toString()));
        if (response.profile !== profile) throw new Error("Wrong profile");
        const result =
          request.action === "probe"
            ? z
                .object({ status: z.literal("host"), pid: z.number().int().positive() })
                .parse(response.result)
            : parseServiceCommandResult(JSON.stringify(response.result));
        if (!result) throw new Error("Invalid result");
        finish(null, result);
      } catch (error) {
        finish(new Error("Invalid system service response", { cause: error }));
      }
    });
  });
}

/** Same-account IPC only. No arbitrary executable, environment or file path is accepted. */
export async function startServiceHostControl(options: {
  endpoint: string;
  profile: string;
  execute(request: ServiceHostRequest): Promise<ServiceCommandResult>;
}): Promise<{ close(): void }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    if (sockets.size >= 16) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    let received = Buffer.alloc(0);
    let handled = false;
    const timer = setTimeout(() => socket.destroy(), 5_000);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      clearTimeout(timer);
      sockets.delete(socket);
    });
    const respond = (result: HostResult) => {
      const payload = `${JSON.stringify({ version: VERSION, profile: options.profile, result })}\n`;
      if (Buffer.byteLength(payload) > RESPONSE_LIMIT) socket.destroy();
      else socket.end(payload);
    };
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      if (received.length + chunk.length > REQUEST_LIMIT) {
        socket.destroy();
        return;
      }
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(10);
      if (newline < 0) return;
      handled = true;
      clearTimeout(timer);
      socket.setTimeout(COMMAND_TIMEOUT_MS, () => socket.destroy());
      try {
        if (
          received
            .subarray(newline + 1)
            .toString()
            .trim()
        )
          throw new Error("Extra request");
        const request = requestSchema.parse(JSON.parse(received.subarray(0, newline).toString()));
        if (request.profile !== options.profile) throw new Error("Wrong profile");
        if (request.action === "probe") {
          respond({ status: "host", pid: process.pid });
          return;
        }
        void options.execute(request).then(respond, () =>
          respond({
            status: "failed",
            code: "COMMAND_FAILED",
            message: "System service command failed",
          }),
        );
      } catch {
        respond({
          status: "failed",
          code: "COMMAND_FAILED",
          message: "Invalid system service request",
        });
      }
    });
  });
  const close = () => {
    server.close();
    for (const socket of sockets) socket.destroy();
  };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.endpoint, () => {
      try {
        setLocalIpcEndpointPermissions(options.endpoint);
        resolve();
      } catch (error) {
        close();
        reject(error);
      }
    });
  });
  return { close };
}
