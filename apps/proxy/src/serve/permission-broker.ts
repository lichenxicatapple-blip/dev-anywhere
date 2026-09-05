import { serviceLogger } from "../common/logger.js";
import type { ApprovalOption, ProviderId } from "@dev-anywhere/shared";

interface PermissionRequest {
  requestId: string;
  sessionId: string;
  provider: ProviderId;
  toolName: string;
  input: Record<string, unknown>;
  options?: ApprovalOption[];
}

export interface PermissionDecision {
  behavior: "allow" | "deny";
  message?: string;
  remember?: boolean;
  optionId?: string;
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
    ...(pending.options ? { options: pending.options } : {}),
    createdAt: pending.createdAt,
    ...(pending.deliveredAt !== undefined ? { deliveredAt: pending.deliveredAt } : {}),
  };
}

export class PermissionBroker {
  private readonly pending = new Map<string, PendingPermission>();

  constructor(private readonly onChange?: (sessionId: string) => void) {}

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
      this.onChange?.(request.sessionId);
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
    this.onChange?.(request.sessionId);
    return true;
  }

  resolve(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    pending.resolve(decision);
    this.onChange?.(pending.sessionId);
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
    this.onChange?.(sessionId);
  }

  cancelHookRequests(reason: string): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.source === "hook") {
        this.resolve(pending.requestId, { behavior: "deny", message: reason });
      }
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
