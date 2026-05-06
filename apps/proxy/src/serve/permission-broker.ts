import { serviceLogger } from "../common/logger.js";
import type { HookProviderId } from "./hook-registry.js";

interface PermissionRequest {
  requestId: string;
  sessionId: string;
  provider: HookProviderId;
  toolName: string;
  input: Record<string, unknown>;
}

interface PermissionDecision {
  behavior: "allow" | "deny";
  message?: string;
}

interface PendingPermission extends PermissionRequest {
  resolve: (decision: PermissionDecision) => void;
  timeout: ReturnType<typeof setTimeout>;
  createdAt: number;
}

export class PermissionBroker {
  private readonly pending = new Map<string, PendingPermission>();

  constructor(private readonly timeoutMs = 120_000) {}

  request(request: PermissionRequest): Promise<PermissionDecision> {
    const existing = this.pending.get(request.requestId);
    if (existing) {
      return Promise.resolve({
        behavior: "deny",
        message: "Duplicate permission request id.",
      });
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request.requestId);
        serviceLogger.warn(
          { sessionId: request.sessionId, requestId: request.requestId },
          "Hook permission request timed out",
        );
        resolve({ behavior: "deny", message: "Permission request timed out." });
      }, this.timeoutMs);

      this.pending.set(request.requestId, {
        ...request,
        resolve,
        timeout,
        createdAt: Date.now(),
      });
    });
  }

  resolve(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    pending.resolve(decision);
    return true;
  }

  get(requestId: string): {
    requestId: string;
    sessionId: string;
    provider: HookProviderId;
    toolName: string;
    input: Record<string, unknown>;
    createdAt: number;
  } | null {
    const pending = this.pending.get(requestId);
    if (!pending) return null;
    return {
      requestId: pending.requestId,
      sessionId: pending.sessionId,
      provider: pending.provider,
      toolName: pending.toolName,
      input: pending.input,
      createdAt: pending.createdAt,
    };
  }

  cleanupSession(sessionId: string, reason: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      clearTimeout(pending.timeout);
      this.pending.delete(requestId);
      pending.resolve({ behavior: "deny", message: reason });
      serviceLogger.info({ sessionId, requestId, reason }, "Pending hook permission dropped");
    }
  }

  listSession(sessionId: string): Array<Omit<PendingPermission, "resolve" | "timeout">> {
    const out: Array<Omit<PendingPermission, "resolve" | "timeout">> = [];
    for (const pending of this.pending.values()) {
      if (pending.sessionId !== sessionId) continue;
      out.push({
        requestId: pending.requestId,
        sessionId: pending.sessionId,
        provider: pending.provider,
        toolName: pending.toolName,
        input: pending.input,
        createdAt: pending.createdAt,
      });
    }
    return out;
  }
}
