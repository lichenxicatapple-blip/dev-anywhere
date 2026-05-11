import { serviceLogger } from "../common/logger.js";
import type { HookProviderId } from "./hook-registry.js";

interface PermissionRequest {
  requestId: string;
  sessionId: string;
  provider: HookProviderId;
  toolName: string;
  input: Record<string, unknown>;
}

export interface PermissionDecision {
  behavior: "allow" | "deny";
  message?: string;
}

interface PendingPermission extends PermissionRequest {
  source: "hook" | "worker";
  resolve: (decision: PermissionDecision) => void;
  createdAt: number;
  deliveredAt?: number;
}

type PendingPermissionView = Omit<PendingPermission, "resolve">;

const DUPLICATE_DECISION: PermissionDecision = {
  behavior: "deny",
  message: "Duplicate permission request id.",
};

function snapshot(pending: PendingPermission): PendingPermissionView {
  return {
    requestId: pending.requestId,
    sessionId: pending.sessionId,
    provider: pending.provider,
    source: pending.source,
    toolName: pending.toolName,
    input: pending.input,
    createdAt: pending.createdAt,
    ...(pending.deliveredAt !== undefined ? { deliveredAt: pending.deliveredAt } : {}),
  };
}

export class PermissionBroker {
  private readonly pending = new Map<string, PendingPermission>();

  request(request: PermissionRequest): Promise<PermissionDecision> {
    if (this.pending.has(request.requestId)) {
      return Promise.resolve(DUPLICATE_DECISION);
    }
    return new Promise((resolve) => {
      this.pending.set(request.requestId, {
        ...request,
        source: "hook",
        resolve,
        createdAt: Date.now(),
      });
    });
  }

  registerWorkerRequest(
    request: PermissionRequest,
    onDecision: (decision: PermissionDecision) => void,
  ): boolean {
    if (this.pending.has(request.requestId)) {
      onDecision(DUPLICATE_DECISION);
      return false;
    }
    this.pending.set(request.requestId, {
      ...request,
      source: "worker",
      resolve: onDecision,
      createdAt: Date.now(),
    });
    return true;
  }

  resolve(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    pending.resolve(decision);
    return true;
  }

  markDelivered(requestId: string): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    pending.deliveredAt = Date.now();
    return true;
  }

  get(requestId: string): PendingPermissionView | null {
    const pending = this.pending.get(requestId);
    return pending ? snapshot(pending) : null;
  }

  cleanupSession(sessionId: string, reason: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      this.pending.delete(requestId);
      pending.resolve({ behavior: "deny", message: reason });
      serviceLogger.info({ sessionId, requestId, reason }, "Pending hook permission dropped");
    }
  }

  listSession(sessionId: string): PendingPermissionView[] {
    const out: PendingPermissionView[] = [];
    for (const pending of this.pending.values()) {
      if (pending.sessionId !== sessionId) continue;
      out.push(snapshot(pending));
    }
    return out;
  }
}
