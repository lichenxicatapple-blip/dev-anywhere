export interface PendingTerminalSubscribe {
  requestId?: string;
}

const MAX_PENDING_SUBSCRIBES_PER_SESSION = 8;

export class TerminalSubscriptionBacklog {
  private readonly pending = new Map<string, PendingTerminalSubscribe[]>();

  add(sessionId: string, requestId?: string): void {
    const entries = this.pending.get(sessionId) ?? [];
    if (requestId && entries.some((entry) => entry.requestId === requestId)) return;
    entries.push({ requestId });
    if (entries.length > MAX_PENDING_SUBSCRIBES_PER_SESSION) {
      entries.splice(0, entries.length - MAX_PENDING_SUBSCRIBES_PER_SESSION);
    }
    this.pending.set(sessionId, entries);
  }

  take(sessionId: string): PendingTerminalSubscribe[] {
    const entries = this.pending.get(sessionId) ?? [];
    this.pending.delete(sessionId);
    return entries;
  }

  delete(sessionId: string): void {
    this.pending.delete(sessionId);
  }
}
