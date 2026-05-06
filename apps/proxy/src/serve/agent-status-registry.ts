import type { AgentStatusPayload } from "@dev-anywhere/shared";

export class AgentStatusRegistry {
  private readonly statuses = new Map<string, AgentStatusPayload>();

  set(sessionId: string, status: AgentStatusPayload): void {
    const current = this.statuses.get(sessionId);
    if (current && current.seq > status.seq) return;
    this.statuses.set(sessionId, status);
  }

  get(sessionId: string): AgentStatusPayload | null {
    return this.statuses.get(sessionId) ?? null;
  }

  list(): Array<{ sessionId: string; status: AgentStatusPayload }> {
    return Array.from(this.statuses, ([sessionId, status]) => ({ sessionId, status }));
  }

  delete(sessionId: string): void {
    this.statuses.delete(sessionId);
  }
}
