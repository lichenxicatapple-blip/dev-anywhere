import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createScopedApprovalRequestIdFactory } from "../common/approval-request-id.js";
import { serviceLogger } from "../common/logger.js";
import { HookRegistry, type HookProviderId } from "./hook-registry.js";
import { PermissionBroker } from "./permission-broker.js";
import { asProvider, asRecord, toolNameFromPayload } from "./hook-payload-helpers.js";

interface HookServerOptions {
  port: number;
  registry: HookRegistry;
  permissionBroker: PermissionBroker;
  host?: string;
  maxBodyBytes?: number;
  isSessionActive?: (sessionId: string) => boolean;
  onEvent?: (event: AuthenticatedHookEvent) => void;
}

export interface AuthenticatedHookEvent {
  sessionId: string;
  provider: HookProviderId;
  event: string;
  requestId?: string;
  payload: Record<string, unknown>;
}

interface HookRequestBody {
  sessionId?: unknown;
  provider?: unknown;
  marker?: unknown;
  event?: unknown;
  requestId?: unknown;
  payload?: unknown;
}

function getBearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

export class HookServer {
  private server: Server | null = null;
  private readonly host: string;
  private readonly maxBodyBytes: number;
  private readonly nextFallbackRequestId = createScopedApprovalRequestIdFactory();

  constructor(private readonly options: HookServerOptions) {
    this.host = options.host ?? "127.0.0.1";
    this.maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        serviceLogger.error({ err: String(err) }, "Hook request failed");
        this.writeJson(res, 500, { error: "internal_error" });
      });
    });

    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        this.server?.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        this.server?.off("error", onError);
        serviceLogger.info({ host: this.host, port: this.options.port }, "Hook server listening");
        resolve();
      };
      this.server!.once("error", onError);
      this.server!.once("listening", onListening);
      this.server!.listen(this.options.port, this.host);
    });
  }

  close(): Promise<void> {
    if (!this.server) return Promise.resolve();
    const server = this.server;
    this.server = null;
    return new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  getListeningPort(): number | null {
    const address = this.server?.address();
    if (!address || typeof address === "string") return null;
    return (address as AddressInfo).port;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST" || req.url !== "/hook") {
      this.writeJson(res, 404, { error: "not_found" });
      return;
    }

    const token = getBearerToken(req);
    if (!token) {
      this.writeJson(res, 401, { error: "missing_token" });
      return;
    }

    const body = await this.readBody(req);
    const parsed = JSON.parse(body) as HookRequestBody;
    const provider = asProvider(parsed.provider);
    if (
      typeof parsed.sessionId !== "string" ||
      typeof parsed.marker !== "string" ||
      typeof parsed.event !== "string" ||
      !provider
    ) {
      this.writeJson(res, 400, { error: "invalid_hook_payload" });
      return;
    }

    const binding = this.options.registry.verify({
      sessionId: parsed.sessionId,
      marker: parsed.marker,
      token,
      provider,
    });
    if (!binding) {
      this.writeJson(res, 403, { error: "invalid_hook_credentials" });
      return;
    }
    if (this.options.isSessionActive && !this.options.isSessionActive(binding.sessionId)) {
      serviceLogger.info(
        { sessionId: binding.sessionId, provider: binding.provider, event: parsed.event },
        "Provider hook ignored for inactive session",
      );
      this.writeNeutralProviderResponse(res);
      return;
    }

    const payload = asRecord(parsed.payload);
    const requestId =
      typeof parsed.requestId === "string"
        ? parsed.requestId
        : typeof payload.tool_use_id === "string"
          ? payload.tool_use_id
          : undefined;
    const event: AuthenticatedHookEvent = {
      sessionId: binding.sessionId,
      provider: binding.provider,
      event: parsed.event,
      ...(requestId !== undefined ? { requestId } : {}),
      payload,
    };

    if (event.event === "PermissionRequest") {
      await this.handlePermissionRequest(event, res);
      return;
    }

    this.options.onEvent?.(event);
    this.writeNeutralProviderResponse(res);
  }

  private async handlePermissionRequest(
    event: AuthenticatedHookEvent,
    res: ServerResponse,
  ): Promise<void> {
    const requestId =
      event.requestId ??
      (typeof event.payload.tool_use_id === "string" ? event.payload.tool_use_id : undefined) ??
      this.nextFallbackRequestId(event.sessionId);
    const toolName = toolNameFromPayload(event.payload);
    const input = asRecord(event.payload.input ?? event.payload.tool_input);

    this.options.onEvent?.({ ...event, requestId });
    const decision = await this.options.permissionBroker.request({
      requestId,
      sessionId: event.sessionId,
      provider: event.provider,
      toolName,
      input,
    });
    this.writeJson(res, 200, this.toProviderDecision(event.event, decision));
  }

  private toProviderDecision(
    eventName: string,
    decision: { behavior: "allow" | "deny"; message?: string },
  ): object {
    if (eventName === "PreToolUse") {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: decision.behavior,
          ...(decision.message ? { permissionDecisionReason: decision.message } : {}),
        },
      };
    }

    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision,
      },
    };
  }

  private writeNeutralProviderResponse(res: ServerResponse): void {
    if (res.headersSent) return;
    // Observation hooks must not override native provider permission modes.
    res.writeHead(200);
    res.end();
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      let size = 0;
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        size += Buffer.byteLength(chunk);
        if (size > this.maxBodyBytes) {
          reject(new Error("hook body too large"));
          req.destroy();
          return;
        }
        body += chunk;
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }

  private writeJson(res: ServerResponse, statusCode: number, payload: object): void {
    if (res.headersSent) return;
    res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  }
}
