# Phase 5: Relay Server - Resilience - Research

**Researched:** 2026-04-07
**Domain:** WebSocket resilience, message buffering, reconnection protocols, seq gap detection
**Confidence:** HIGH

## Summary

Phase 5 transforms the relay from a stateless transparent forwarder (Phase 4) into a resilient message broker that survives real-world network instability. The core challenges are: (1) proxy auto-reconnect with exponential backoff, (2) per-session message buffering with intelligent compression at the relay, (3) client reconnect with incremental replay, and (4) seq gap detection and repair.

The implementation builds on the existing Phase 4 codebase: `RelayRegistry`, `RelayControlSchema`, `MessageEnvelopeSchema`, and the routing infrastructure in `router.ts`. The key architectural shift is that the relay must now parse `MessageEnvelope` fields (sessionId, type, seq) to perform buffering and compression -- it is no longer a dumb pipe. The proxy's `RelayConnection` class needs significant enhancement from its current bare-bones connect/send/close implementation.

**Primary recommendation:** Implement in three layers: (1) proxy-side reconnection + outbound message queue, (2) relay-side per-session buffer with compression, (3) client reconnection protocol with incremental replay. No external dependencies beyond what Phase 4 already uses.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Exponential backoff + random jitter, infinite retry (no max attempts). Initial 1s, doubling, cap at 30s. After cap, fixed 30s retry indefinitely.
- **D-02:** During relay disconnection, proxy-side uses in-memory queue to buffer outbound messages; flush in order on reconnect.
- **D-03:** Buffer logic consolidated into MessageQueue class (enqueue/drain/size). Phase 5 uses memory implementation. Interface designed for future persistence extension (swap to NDJSON file implementation without caller changes).
- **D-04:** Reconnect using original proxyId via proxy_register; relay identifies as reconnection and restores state.
- **D-05:** Buffer is per-session, not per-proxy. Each session has independent buffer, compression, cleanup. Proxy registry maintains proxyId -> sessionId set mapping.
- **D-06:** In-memory queue storage. v1 single-instance relay, no Redis or external dependencies (2GB server memory constraint).
- **D-07:** 1000 message cap per-session buffer.
- **D-08:** PTY session compression: on snapshot event, discard all messages before snapshot in that session buffer. Keep only latest snapshot + subsequent increments.
- **D-09:** JSON session compression: on result event (turn end), discard all intermediate streaming deltas and stream_events for that turn. Keep only user messages + result events + pending control_requests.
- **D-10:** Relay must parse MessageEnvelope's sessionId and message type for grouping and compression. Phase 5 relay is no longer Phase 4's stateless passthrough.
- **D-11:** Proxy disconnection grace period: 30 minutes. Reconnect within grace period restores everything; timeout clears all state.
- **D-12:** While proxy is online, session buffers persist (subject to count cap and compression). No TTL. 30-minute countdown starts only on proxy disconnect.
- **D-13:** Client generates nanoid clientId on first launch, persists to tt.setStorageSync. All reconnections reuse same clientId.
- **D-14:** Client reconnect protocol: send client_register(clientId, lastSeq). Relay responds with restored/proxy_offline/new status.
- **D-15:** Relay auto-restores client's proxy binding; client does not need to re-send proxy_select.
- **D-16:** No client TTL. Buffer lifecycle tied to proxy connection, not client. Client connects anytime, gets messages from per-session buffer as long as proxy is online or within grace period.
- **D-17:** Cold start: render cached messages from storage first (zero wait), background connect to relay for increments.
- **D-18:** Proxy offline: relay sends proxy_offline event; mini program shows "computer offline" status.
- **D-19:** Receivers (proxy and client) each track received seq; on gap detection, send replay_request(fromSeq, toSeq).
- **D-20:** Relay looks up requested range in per-session buffer and resends. If buffer doesn't have it, returns gap_unrecoverable; receiver skips and logs.
- **D-21:** No ACK mechanism. Buffers expire naturally via proxy lifecycle + compression, not waiting for receiver confirmation.
- **D-22:** PTY sessions can only be terminated from desktop; mobile cannot terminate PTY sessions. JSON sessions can be terminated from mobile.
- **D-23:** Session termination permissions enforced at proxy side (proxy checks session mode on terminate request). Relay stays business-logic agnostic.

### Claude's Discretion
- Exponential backoff jitter algorithm details
- MessageQueue class internal implementation
- Relay buffer internal data structure choices
- replay_request timeout parameters
- New control message zod schema design specifics
- Relay compression trigger implementation details

### Deferred Ideas (OUT OF SCOPE)
- JSON worker local event buffering (session-worker.ts sendToServe silent drop issue)
- Proxy-side EventStore replay to relay (client offline >30 min, relay buffer cleared)
- Authentication flow (pairing code + long-term token) -- Phase 6 prerequisite
- Mini program local message cache snapshot cleanup strategy
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| RELAY-02 | Auto-reconnect (exponential backoff), disconnection message queue, session state recovery after reconnect | Proxy-side: RelayConnection enhancement with backoff, MessageQueue class, proxy_register reconnect. Relay-side: grace period timer, per-session buffers, reconnect detection in registry. |
| RELAY-04 | Feishu mini program background destroy buffering, reconnect replay of missed messages | Relay-side: per-session buffer with seq tracking, client_register protocol with lastSeq, incremental replay. Client-side: clientId persistence, lastSeq tracking, replay_request for gaps. |
</phase_requirements>

## Standard Stack

### Core (already installed, no new dependencies)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `ws` | ^8.20.0 | WebSocket server & client | Already in relay and proxy. No change needed. | [VERIFIED: apps/relay/package.json] |
| `zod` | ^4.3.6 | Schema validation for new control messages | Already in shared package via proxy dep. Extend RelayControlSchema. | [VERIFIED: apps/proxy/package.json] |
| `pino` | ^9.6.0 | Structured logging | Already in relay. | [VERIFIED: apps/relay/package.json] |
| `nanoid` | ^5.1.7 | ID generation (clientId, etc.) | Already in relay and proxy. | [VERIFIED: apps/relay/package.json] |
| `vitest` | ^4.1.2 | Testing | Already in relay devDeps. | [VERIFIED: apps/relay/package.json] |

### No New Dependencies Needed
Phase 5 requires zero new npm packages. All functionality is built on existing dependencies.

**Regarding `reconnecting-websocket`:** The project stack lists `reconnecting-websocket@^4.4.0` as a supporting library. However, this package was last published in 2020 [VERIFIED: npm registry, last publish 2020-02-07] and is effectively unmaintained. Since the CONTEXT.md decisions specify custom exponential backoff with specific parameters (D-01: initial 1s, doubling, cap 30s, infinite retry, random jitter), and the MessageQueue integration (D-02, D-03) requires tight coupling with reconnection state, building the reconnection logic directly into `RelayConnection` is the correct approach. The reconnection logic is ~40 lines of code and does not warrant an external dependency.

## Architecture Patterns

### Recommended Changes to Existing Structure
```
packages/shared/src/schemas/
  relay-control.ts          # EXTEND: add client_register, replay_request, etc.

apps/relay/src/
  registry.ts               # EXTEND: grace period, per-session buffers, client bindings by ID
  router.ts                 # EXTEND: buffer writes instead of direct forwarding
  handlers/proxy.ts         # EXTEND: reconnect detection, grace period cancel/start
  handlers/client.ts        # EXTEND: client_register protocol, incremental replay
  session-buffer.ts         # NEW: per-session message buffer with compression
  buffer-compressor.ts      # NEW: snapshot/result compression logic

apps/proxy/src/
  relay-connection.ts       # EXTEND: exponential backoff, auto-reconnect, MessageQueue
  message-queue.ts          # NEW: MessageQueue class with enqueue/drain/size interface
```

### Pattern 1: Exponential Backoff with Jitter
**What:** Proxy reconnects to relay with increasing delays and random jitter to avoid thundering herd.
**When to use:** Every time the WebSocket connection to relay is lost (close event or error).
**Example:**
```typescript
// Full jitter algorithm (AWS-recommended pattern)
// Source: https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
function calculateBackoff(attempt: number, baseMs = 1000, capMs = 30000): number {
  const exponential = Math.min(capMs, baseMs * Math.pow(2, attempt));
  // Full jitter: random between 0 and exponential
  return Math.random() * exponential;
}
```
[CITED: AWS Architecture Blog - Exponential Backoff and Jitter]

### Pattern 2: MessageQueue with Pluggable Backend
**What:** Abstract queue interface that the proxy uses to buffer outbound messages during disconnection.
**When to use:** Proxy-side, wrapping RelayConnection.send().
**Example:**
```typescript
// Interface that both memory and future NDJSON implementations satisfy
interface MessageQueue {
  enqueue(raw: string): void;
  drain(): string[];
  size(): number;
  clear(): void;
}

class MemoryMessageQueue implements MessageQueue {
  private items: string[] = [];
  enqueue(raw: string): void { this.items.push(raw); }
  drain(): string[] { const all = this.items; this.items = []; return all; }
  size(): number { return this.items.length; }
  clear(): void { this.items = []; }
}
```
[ASSUMED - interface design per D-03]

### Pattern 3: Per-Session Buffer with Compression
**What:** Relay maintains a bounded message buffer per session, applying compression when snapshot/result events arrive.
**When to use:** Every message routed through relay gets buffered per session.
**Example:**
```typescript
// Buffer stores raw JSON strings with parsed metadata for compression
interface BufferedMessage {
  raw: string;
  seq: number;
  type: string;    // MessageEnvelope.type
  source: string;  // "proxy" | "client"
}

class SessionBuffer {
  private messages: BufferedMessage[] = [];
  private readonly maxSize = 1000; // D-07

  append(msg: BufferedMessage): void {
    this.messages.push(msg);
    if (this.messages.length > this.maxSize) {
      this.messages.shift(); // FIFO eviction
    }
  }

  // D-08: PTY snapshot compression
  compressOnSnapshot(snapshotSeq: number): void {
    const snapshotIdx = this.messages.findIndex(m => m.seq === snapshotSeq);
    if (snapshotIdx > 0) {
      this.messages = this.messages.slice(snapshotIdx);
    }
  }

  getAfterSeq(lastSeq: number): BufferedMessage[] {
    return this.messages.filter(m => m.seq > lastSeq);
  }
}
```
[ASSUMED - data structure per D-05 through D-09]

### Pattern 4: Client Register Protocol
**What:** Stateful client reconnection with three-way response status.
**When to use:** Client connects to relay, first message is always client_register.
**Example:**
```typescript
// New control message types
// client -> relay
{ type: "client_register", clientId: "nano-id-here", lastSeq: 42 }

// relay -> client responses
{ type: "client_register_response", status: "restored", proxyId: "...", messages: [...] }
{ type: "client_register_response", status: "proxy_offline", proxyId: "..." }
{ type: "client_register_response", status: "new" }
```
[ASSUMED - protocol design per D-14]

### Anti-Patterns to Avoid
- **Global message buffer:** Do NOT use a single buffer for all sessions. Per D-05, buffers are per-session. A global buffer makes compression impossible and creates cross-session data leaks.
- **ACK-based buffer cleanup:** Do NOT implement ACK tracking per D-21. Buffers expire via proxy lifecycle + compression, not receiver acknowledgment. Adding ACKs introduces complexity with zero benefit for a single-user tool.
- **Relay-side business logic:** Per D-23, relay must NOT interpret session mode or enforce termination permissions. The relay buffers and routes; the proxy enforces business rules.
- **Blocking reconnection:** Do NOT pause the entire proxy while reconnecting. Sessions must continue running locally; messages queue up and flush on reconnect.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Exponential backoff math | Custom retry library | ~10 lines inline: `Math.min(cap, base * 2^attempt) * Math.random()` | Too simple for a dependency. Full jitter is 1 line of math. |
| Message schema validation | Manual JSON.parse + field checks | Extend existing `RelayControlSchema` with zod discriminatedUnion | Project pattern; schema drift is the real risk. |
| WebSocket reconnection | `reconnecting-websocket` package | Custom reconnect in RelayConnection | Package unmaintained since 2020 [VERIFIED: npm registry]. Custom impl needed for MessageQueue integration anyway. |

**Key insight:** Phase 5 is entirely about custom application logic (buffer management, compression, protocol state machines). There are no off-the-shelf libraries that solve "per-session message buffering with snapshot compression for a WebSocket relay." The value is in correct implementation of the CONTEXT.md decisions, not in library selection.

## Common Pitfalls

### Pitfall 1: Race Between Reconnect and Grace Period Cleanup
**What goes wrong:** Proxy disconnects. The 30-minute grace period timer starts. Just as the timer fires, the proxy reconnects. The cleanup runs and wipes the session buffers that the proxy expects to find.
**Why it happens:** setTimeout callbacks and WebSocket connection events are both async. Without proper synchronization, the cleanup can race with the reconnect registration.
**How to avoid:** When processing proxy_register for a known proxyId, FIRST cancel the grace period timer, THEN restore state. The timer callback must check if the proxy has reconnected before deleting anything.
**Warning signs:** Intermittent "buffer not found" errors shortly after reconnection. Reproducible by reconnecting at exactly the grace period boundary.

### Pitfall 2: Seq Space Confusion Between Proxy and Client
**What goes wrong:** Per Phase 4 D-09, proxy and client have independent seq spaces. If the relay buffer stores messages from both directions and a client sends `replay_request(fromSeq=10, toSeq=20)`, the relay might return proxy-sourced messages with seq 10-20 AND client-sourced messages with seq 10-20.
**Why it happens:** The `seq` field alone is ambiguous without the `source` field. Two messages can have the same seq number if one is from proxy and one is from client.
**How to avoid:** The per-session buffer must be directional, or replay_request must specify the source direction. Since clients only need to replay proxy->client messages (they already have their own sent messages), buffer and replay should be scoped by source direction.
**Warning signs:** Duplicate messages appearing after replay. Client receiving its own messages back.

### Pitfall 3: Buffer Compression Deleting Undelivered Messages
**What goes wrong:** A snapshot event arrives and triggers compression (D-08). The compression deletes all pre-snapshot messages. But a client that was disconnected since before the snapshot hasn't received those messages yet. When it reconnects and requests replay from its lastSeq, those messages are gone.
**Why it happens:** Compression is optimized for the common case (client is connected). It doesn't account for disconnected clients whose lastSeq predates the snapshot.
**How to avoid:** This is acceptable behavior per the CONTEXT.md design. The snapshot itself contains the complete state, so the client can reconstruct from snapshot + increments. The relay should send the snapshot as the first message in the replay, then subsequent messages. The client must handle receiving a snapshot that jumps ahead of its expected seq.
**Warning signs:** Client UI shows a gap in conversation history. Mitigated by the fact that snapshot = complete state.

### Pitfall 4: Memory Exhaustion from Unbounded Buffers
**What goes wrong:** With 1000 messages per session (D-07) and potentially large messages (assistant_message with long code blocks), memory usage can spike. If multiple sessions are active and the proxy disconnects (preventing compression from triggering), memory grows.
**Why it happens:** JSON strings are stored in memory. A single large assistant_message can be 100KB+. 1000 such messages = 100MB per session.
**How to avoid:** The 1000-message cap (D-07) provides the primary guard. Additionally, monitor total buffer memory in the /status endpoint. Consider message-size-aware eviction if needed (not in Phase 5 scope but worth logging sizes for future optimization).
**Warning signs:** Node.js process memory exceeding 500MB. OOM kills on the 2GB server.

### Pitfall 5: Client Register Response Too Large
**What goes wrong:** Client reconnects with lastSeq=0 (cold start after cache wipe). The relay tries to send the entire session buffer (up to 1000 messages) in a single client_register_response. This creates a massive WebSocket frame that may exceed memory limits or cause the client to choke.
**Why it happens:** Naive implementation sends all buffered messages in one response payload.
**How to avoid:** Stream replay messages individually after the initial client_register_response status message. The response only contains the status and binding info; actual messages follow as individual MessageEnvelope frames. This also simplifies client-side processing (same handler for live and replay messages).
**Warning signs:** WebSocket connection drops immediately after large replay. Client freezes on reconnect.

### Pitfall 6: Timer Leak on Server Shutdown
**What goes wrong:** Grace period timers (30-minute setTimeout) are created when proxies disconnect. If the relay server shuts down without clearing these timers, Node.js won't exit cleanly because active timers keep the event loop alive.
**Why it happens:** setTimeout returns a reference that must be explicitly cleared. The existing `server.close()` doesn't know about grace period timers.
**How to avoid:** Track all active grace period timers in the registry. On server shutdown, clear all timers. Use `timer.unref()` as a safety net so leaked timers don't prevent process exit.
**Warning signs:** Relay process hangs on SIGTERM. Stale processes accumulate on the server.

## Code Examples

### Extending RelayControlSchema for Phase 5
```typescript
// Source: existing relay-control.ts pattern + CONTEXT.md D-14, D-19, D-20
export const RelayControlSchema = z.discriminatedUnion("type", [
  // ... existing Phase 4 types ...
  z.object({ type: z.literal("proxy_register"), proxyId: z.string().min(1) }),
  z.object({ type: z.literal("proxy_list_request") }),
  z.object({
    type: z.literal("proxy_list_response"),
    proxies: z.array(z.object({ proxyId: z.string() })),
  }),
  z.object({ type: z.literal("proxy_select"), proxyId: z.string().min(1) }),
  z.object({
    type: z.literal("relay_error"),
    code: z.string(),
    message: z.string(),
  }),

  // Phase 5 additions
  z.object({
    type: z.literal("client_register"),
    clientId: z.string().min(1),
    lastSeq: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("client_register_response"),
    status: z.enum(["restored", "proxy_offline", "new"]),
    proxyId: z.string().optional(),
  }),
  z.object({
    type: z.literal("replay_request"),
    sessionId: z.string().min(1),
    fromSeq: z.number().int().nonnegative(),
    toSeq: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("replay_response"),
    sessionId: z.string().min(1),
    messages: z.array(z.record(z.string(), z.unknown())),
  }),
  z.object({
    type: z.literal("gap_unrecoverable"),
    sessionId: z.string().min(1),
    fromSeq: z.number().int().nonnegative(),
    toSeq: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("proxy_offline"),
    proxyId: z.string(),
  }),
]);
```
[ASSUMED - schema design based on CONTEXT.md decisions]

### RelayConnection with Auto-Reconnect
```typescript
// Source: existing relay-connection.ts pattern + D-01, D-02, D-04
class RelayConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private queue: MessageQueue = new MemoryMessageQueue();
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false; // intentional close vs unexpected disconnect

  connect(): void {
    this.closed = false;
    this.doConnect();
  }

  private doConnect(): void {
    const url = this.relayUrl.replace(/\/$/, "") + "/proxy";
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.reconnectAttempt = 0; // reset on success
      this.ws!.send(JSON.stringify({ type: "proxy_register", proxyId: this.proxyId }));
      this.flushQueue();
      this.emit("connected");
    });

    this.ws.on("close", () => {
      this.ws = null;
      if (!this.closed) this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      this.logger.error({ error: String(err) }, "Relay connection error");
    });

    this.ws.on("message", (data) => {
      this.emit("message", data.toString());
    });
  }

  send(envelope: MessageEnvelope): void {
    const raw = JSON.stringify(envelope);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(raw);
    } else {
      this.queue.enqueue(raw);
    }
  }

  private flushQueue(): void {
    for (const raw of this.queue.drain()) {
      this.ws?.send(raw);
    }
  }

  private scheduleReconnect(): void {
    const backoff = calculateBackoff(this.reconnectAttempt, 1000, 30000);
    this.logger.info({ attempt: this.reconnectAttempt, delayMs: Math.round(backoff) }, "Scheduling reconnect");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempt++;
      this.doConnect();
    }, backoff);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}
```
[ASSUMED - implementation pattern based on D-01 through D-04 and existing code]

### Registry Extension for Grace Period
```typescript
// Source: existing registry.ts + D-05, D-11, D-12
interface ProxyState {
  ws: WebSocket | null;       // null during grace period
  sessions: Set<string>;      // sessionIds owned by this proxy
  graceTimer: NodeJS.Timeout | null;
  disconnectedAt: number | null;
}

interface ClientBinding {
  proxyId: string;
  // Future: lastSeq per session for incremental replay
}

// Extended registry tracks proxy state and client identity
class RelayRegistry {
  private proxies = new Map<string, ProxyState>();
  private clientBindings = new Map<string, ClientBinding>(); // keyed by clientId
  private clientSockets = new Map<string, WebSocket>();      // keyed by clientId
  private sessionBuffers = new Map<string, SessionBuffer>(); // keyed by sessionId

  registerProxy(proxyId: string, ws: WebSocket): "new" | "reconnected" {
    const existing = this.proxies.get(proxyId);
    if (existing) {
      // Reconnection: cancel grace period, restore WebSocket
      if (existing.graceTimer) clearTimeout(existing.graceTimer);
      if (existing.ws) existing.ws.terminate();
      existing.ws = ws;
      existing.disconnectedAt = null;
      existing.graceTimer = null;
      return "reconnected";
    }
    this.proxies.set(proxyId, {
      ws,
      sessions: new Set(),
      graceTimer: null,
      disconnectedAt: null,
    });
    return "new";
  }
}
```
[ASSUMED - design based on D-04, D-05, D-11, D-12 and existing registry.ts]

## State of the Art

| Old Approach (Phase 4) | Current Approach (Phase 5) | Impact |
|------------------------|---------------------------|--------|
| Relay stateless passthrough | Relay parses envelope for sessionId/type/seq | Enables per-session buffering and compression |
| Proxy `send()` drops if disconnected | Proxy queues to MessageQueue, flushes on reconnect | Zero message loss during disconnection |
| Client bindings by WebSocket reference | Client bindings by persistent clientId | Survives WebSocket reconnection |
| No grace period; disconnect = immediate cleanup | 30-minute grace period with timer | Proxy can restart/reconnect without losing state |
| routeProxyMessage sends directly to clients | Route through per-session buffer first | Enables replay for disconnected clients |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Full jitter (random between 0 and exponential) is the correct jitter algorithm for D-01 | Architecture Patterns | Low - any jitter is acceptable per Claude's Discretion |
| A2 | replay_response sends messages individually as frames, not batched in a single JSON array | Pitfall 5 / Code Examples | Medium - if batched, large replays could OOM the client |
| A3 | Per-session buffer needs only proxy->client direction for client replay | Pitfall 2 | Low - client already has its own messages; proxy never requests replay in Phase 5 scope |
| A4 | The existing `SyncRequestPayloadSchema` and `SyncResponsePayloadSchema` in system.ts are superseded by the new `client_register` / `replay_request` control messages | Code Examples | Medium - might want to keep sync_request for future use |
| A5 | PTY snapshot events can be identified by a specific message type in the envelope | Architecture Patterns | Medium - need to verify how TerminalTracker snapshots are represented in MessageEnvelope |

## Open Questions

1. **How are PTY snapshot events represented in MessageEnvelope?**
   - What we know: TerminalTracker calls `store.writeSnapshot()` on the proxy-side EventStore. The serve.ts forwards worker_events to relay as `assistant_message` with `isPartial: true`.
   - What's unclear: There is no dedicated "snapshot" MessageEnvelope type. PTY snapshots go into EventStore but may not be forwarded to relay at all in the current code. The relay needs to know when a snapshot occurs to trigger buffer compression (D-08).
   - Recommendation: Add a new envelope type (e.g., `session_status` with a `snapshot` state) or a dedicated `snapshot` type to the MessageEnvelope schema. Alternatively, the proxy can emit a control message to relay when a snapshot occurs.

2. **How does the proxy tell the relay which sessions it owns?**
   - What we know: Per D-05, relay must maintain proxyId -> sessionId mapping. Currently, the relay sees sessionId in every MessageEnvelope.
   - What's unclear: Should the proxy explicitly declare its sessions on connect, or should the relay infer them from message traffic?
   - Recommendation: Lazy inference -- when the relay sees a MessageEnvelope with a new sessionId from a proxy, it adds that sessionId to the proxy's session set. This avoids a new protocol message and works naturally.

3. **What happens to client-to-proxy messages when proxy is in grace period?**
   - What we know: D-18 says relay sends proxy_offline when proxy disconnects. Client shows "computer offline" status.
   - What's unclear: Should the relay buffer client->proxy messages during grace period, or reject them immediately?
   - Recommendation: Reject with relay_error code "PROXY_OFFLINE". Client messages during proxy downtime are user inputs that can't be processed anyway. Buffering them creates ordering confusion when proxy reconnects. The client UI should prevent sending when proxy is offline.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^4.1.2 |
| Config file | `apps/relay/vitest.config.ts` |
| Quick run command | `pnpm --filter @cc-anywhere/relay test` |
| Full suite command | `pnpm test` (workspace-wide) |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| RELAY-02a | Proxy auto-reconnect with exponential backoff | unit | `pnpm --filter @cc-anywhere/proxy test -- --grep "reconnect"` | Wave 0 |
| RELAY-02b | MessageQueue enqueue/drain/size interface | unit | `pnpm --filter @cc-anywhere/proxy test -- --grep "MessageQueue"` | Wave 0 |
| RELAY-02c | Proxy reconnect restores session state via proxy_register | integration | `pnpm --filter @cc-anywhere/relay test -- --grep "reconnect"` | Wave 0 |
| RELAY-02d | Grace period: 30min timer, cancel on reconnect, cleanup on expire | unit | `pnpm --filter @cc-anywhere/relay test -- --grep "grace"` | Wave 0 |
| RELAY-02e | Messages queued during disconnect delivered after reconnect | integration | `pnpm --filter @cc-anywhere/relay test -- --grep "queue flush"` | Wave 0 |
| RELAY-04a | Per-session buffer with 1000-message cap | unit | `pnpm --filter @cc-anywhere/relay test -- --grep "SessionBuffer"` | Wave 0 |
| RELAY-04b | PTY snapshot compression discards pre-snapshot messages | unit | `pnpm --filter @cc-anywhere/relay test -- --grep "snapshot compression"` | Wave 0 |
| RELAY-04c | JSON result compression discards intermediate streaming | unit | `pnpm --filter @cc-anywhere/relay test -- --grep "result compression"` | Wave 0 |
| RELAY-04d | client_register protocol with restored/proxy_offline/new states | integration | `pnpm --filter @cc-anywhere/relay test -- --grep "client_register"` | Wave 0 |
| RELAY-04e | Incremental replay sends only messages after lastSeq | integration | `pnpm --filter @cc-anywhere/relay test -- --grep "replay"` | Wave 0 |
| RELAY-04f | replay_request/gap_unrecoverable protocol | integration | `pnpm --filter @cc-anywhere/relay test -- --grep "gap"` | Wave 0 |
| RELAY-04g | proxy_offline event sent to clients on proxy disconnect | integration | `pnpm --filter @cc-anywhere/relay test -- --grep "proxy_offline"` | Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm --filter @cc-anywhere/relay test && pnpm --filter @cc-anywhere/proxy test`
- **Per wave merge:** `pnpm test` (full workspace)
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `apps/relay/src/__tests__/session-buffer.test.ts` -- covers RELAY-04a, 04b, 04c
- [ ] `apps/relay/src/__tests__/grace-period.test.ts` -- covers RELAY-02d
- [ ] `apps/relay/src/__tests__/client-register.test.ts` -- covers RELAY-04d, 04e, 04g
- [ ] `apps/relay/src/__tests__/replay.test.ts` -- covers RELAY-04f
- [ ] `apps/proxy/src/__tests__/relay-connection.test.ts` -- covers RELAY-02a, 02b, 02e
- [ ] `packages/shared/src/schemas/__tests__/relay-control.test.ts` -- UPDATE existing to cover new message types

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no (deferred to Phase 6) | -- |
| V3 Session Management | yes | Grace period timer prevents indefinite state retention; 30-minute cap prevents resource exhaustion |
| V4 Access Control | partial | D-22/D-23: session termination permission checks at proxy. Relay does not enforce. |
| V5 Input Validation | yes | zod schema validation on all control messages via RelayControlSchema |
| V6 Cryptography | no | -- |

### Known Threat Patterns for WebSocket Relay

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Buffer exhaustion attack (malicious proxy sends unlimited messages) | Denial of Service | Per-session 1000-message cap (D-07), per-proxy session limit (monitor in /status) |
| Grace period abuse (proxy connects/disconnects repeatedly to consume timer resources) | Denial of Service | Single timer per proxyId; reconnect cancels existing timer before creating new one |
| ClientId spoofing (attacker uses another user's clientId to hijack session) | Spoofing | Mitigated in Phase 6 (auth). Phase 5 is pre-auth; document as known risk. |
| Replay amplification (client sends replay_request for large ranges repeatedly) | Denial of Service | Rate-limit replay_request per client connection; buffer size naturally limits response |

## Project Constraints (from CLAUDE.md)

- Log messages in English
- Comments and docstrings in Chinese
- No emoji in code
- No lazy imports (all imports at file top)
- No silent fallback; errors must throw explicitly
- Use `rmtrash` instead of `rm`
- Reuse existing code patterns; avoid reinventing
- Commit messages concise, one-sentence summary
- Do not add unnecessary adapter layers for backward compatibility
- No Co-Authored-By, test count, coverage info in commit messages

## Sources

### Primary (HIGH confidence)
- `apps/relay/src/` -- Current relay implementation read in full [VERIFIED: codebase]
- `apps/proxy/src/relay-connection.ts` -- Current proxy relay connection [VERIFIED: codebase]
- `packages/shared/src/schemas/relay-control.ts` -- Current control schema [VERIFIED: codebase]
- `packages/shared/src/schemas/envelope.ts` -- MessageEnvelope schema with 16 types [VERIFIED: codebase]
- `apps/relay/package.json` -- Dependency versions [VERIFIED: codebase]
- `apps/proxy/package.json` -- Dependency versions [VERIFIED: codebase]
- npm registry: `reconnecting-websocket` last published 2020-02-07 [VERIFIED: npm view]
- npm registry: `ws@8.20.0` current [VERIFIED: npm view]

### Secondary (MEDIUM confidence)
- AWS Architecture Blog: Exponential Backoff and Jitter patterns [CITED: aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/]
- `.planning/research/PITFALLS.md` -- Pitfall 4 (message loss on reconnect) directly relevant [VERIFIED: codebase]
- `.planning/phases/04-relay-server-core-transport/04-CONTEXT.md` -- Phase 4 decisions on seq spaces [VERIFIED: codebase]

### Tertiary (LOW confidence)
- None. All claims verified against codebase or cited from official sources.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new dependencies, all verified in existing package.json
- Architecture: HIGH - patterns derived directly from CONTEXT.md locked decisions and existing codebase structure
- Pitfalls: HIGH - identified from real code analysis (race conditions, memory bounds, seq confusion)

**Research date:** 2026-04-07
**Valid until:** 2026-05-07 (stable domain, no external dependency changes expected)
