# Codebase Concerns

**Analysis Date:** 2026-04-20

Scope: monorepo `apps/proxy`, `apps/relay`, `apps/web`, `packages/shared`. Findings below are specific, with file:line evidence. Severity reflects impact × likelihood. No hedging — if something is listed as HIGH it is a real problem, not a theoretical concern.

## Tech Debt

**Monolithic `serve.ts` (1183 lines, inline dispatcher)**
- Severity: **HIGH**
- File: `apps/proxy/src/serve.ts` (entire file; the `on("message")` handler alone is L811-L1129)
- Issue: A single arrow function attached to `relayConnection.on("message")` contains a 330-line `if/else if` chain that parses inbound relay messages as untyped `parsed: any`, handles 15+ different message types, updates session state, launches workers, emits outbound envelopes, sends optimistic acks, and triggers history file I/O. Everything is coupled via closure captures (`sessionManager`, `workerSockets`, `terminalSockets`, `pendingToolApprovals`, `claudeSessionIds`, `relayConnection`, `controlHandlers`, `relaySend`).
- Impact: Any new message type, or any change to an existing one, forces a read of the entire handler to understand ordering and state effects. Tests cannot exercise individual branches in isolation — only the E2E path. This is where most of the "heavy patching" debt sits.
- Fix approach: Extract a `RelayMessageRouter` class with one method per message type, injected dependencies, and Zod-typed parse (use `RelayControlSchema` / `MessageEnvelopeSchema` like the relay already does in `router.ts`). `serve.ts` becomes wiring only.

**Runtime message parsing bypasses shared Zod schemas**
- Severity: **HIGH**
- File: `apps/proxy/src/serve.ts:811-1129`
- Evidence: `const parsed = JSON.parse(data);` then `parsed.type === "user_input"`, `parsed.payload?.text`, `parsed.payload?.toolId`, etc. as `any`. `packages/shared/src/schemas/envelope.ts` and `relay-control.ts` define exhaustive Zod schemas that are never applied here.
- Impact: Protocol drift is invisible. When `relay-control.ts` adds a new field, proxy silently ignores it. When a client sends a malformed payload, proxy throws or produces undefined behaviour deep inside a branch, not at the edge.
- Fix approach: `const result = RelayControlSchema.safeParse(parsed); if (!result.success) return early;` — mirror what `apps/relay/src/router.ts:18` already does.

**Two SeqCounter writers for the same file**
- Severity: **HIGH**
- Files: `apps/proxy/src/session-worker.ts:39`, `apps/proxy/src/serve.ts:268`
- Evidence: Both instantiate `new SeqCounter(sessionId)` against the same path `${sessionDir}/seq`. session-worker advances on every `worker_event`; serve advances on every `worker_approval_request` seen (approval path).
- Repro: Start a JSON session that triggers a tool approval. `seqCounter.next()` in worker (say at seq N) and in serve (at seq 1 if freshly loaded, or N' after concurrent writes) race on the same `${dir}/seq` file via `writeFileSync` each call.
- Impact: seq collisions → client sees out-of-order seqs → gap detection and replay logic (already stubbed out, see below) gets wedged. Also a correctness bug waiting to ship once replay is re-implemented.
- Fix approach: Make session-worker the single writer for envelope seqs; remove `new SeqCounter(sessionId)` from `serve.ts:268`. The approval seq should be requested from the worker or use a separate counter namespace.

**Every stream-json event writes to disk synchronously**
- Severity: **MED**
- Files: `apps/proxy/src/seq-counter.ts:20-23`, `apps/proxy/src/session-worker.ts:85`
- Evidence: `SeqCounter.next()` does `this.seq++; this.save();` where `save()` is `writeFileSync(this.filePath, String(this.seq))`. session-worker.ts calls this for every stream-json event from Claude (L85 inside `onEvent`), which for a typical assistant response can be dozens of events per second (text deltas, thinking, tool_use).
- Impact: Blocks the event loop. On a slow disk or under load, assistant streaming latency is bounded by fsync rate. This is a synchronous IO hotpath.
- Fix approach: Debounce the seq save (e.g. last-write-wins on 500ms timer + save on exit), or move to an append-only counter log with coarser fsync cadence.

**`SeqCounter.next()` is called with `await`-free `writeFileSync`, but caller is `async`**
- Severity: **LOW**
- File: `apps/proxy/src/seq-counter.ts:20-23`
- Evidence: `next(): number { this.seq++; this.save(); return this.seq; }` — blocking sync IO inside a hot loop feeding an async pipeline.
- Impact: Same latency impact as above but also hides the cost; linters won't flag it.

**`session_list` type collision across protocol layers**
- Severity: **HIGH**
- Files:
  - Control: `packages/shared/src/schemas/relay-control.ts:148` — `z.object({ type: z.literal("session_list") })` (empty payload, a request)
  - Envelope: `packages/shared/src/schemas/envelope.ts:84-87` + `session.ts:31-35` — `session_list` with `payload.sessions` (a response)
- Evidence: Same literal `"session_list"` appears in two schemas. `parseMessage` in `apps/relay/src/router.ts:18-37` tries `RelayControlSchema.safeParse` first. Because Zod object schemas don't reject extra keys by default (verified: `z.object({type:z.literal("session_list")}).safeParse({type:"session_list", sessionId:"", seq:0, ..., payload:{sessions:[]}}).success === true`), an envelope-shaped `session_list` **matches both schemas**. Control wins.
- Downstream: `PROXY_TO_CLIENT_TYPES` at `apps/relay/src/handlers/proxy.ts:23` includes `"session_list"`, so the raw message gets forwarded. Client code at `apps/web/src/services/session-dispatcher.ts:62-65` then uses `if ("payload" in msg)` to disambiguate at the destination — a brittle runtime type guard that compensates for a schema collision.
- Impact: Any future change to the control schema (e.g., adding a field) may collide differently. New contributors reading the code cannot tell which schema is authoritative.
- Fix approach: Rename one side (e.g., control `session_list` → `session_list_request`, envelope `session_list` → keep) OR use `z.strictObject` on the control schema to force the discriminant. Cross-package change; will require bumping relay + proxy + web in lockstep.

**`session_sync` / `session_list` / `pty_state` / etc. shaped as envelope-wrapped objects with fake envelope fields**
- Severity: **MED**
- File: `apps/proxy/src/serve.ts:604-614, 636-646, 730-740, 960-967, 1043-1050, 1080-1087`
- Evidence: Proxy emits control-layer messages like `session_list` with `sessionId: ""`, `seq: 0`, `timestamp: Date.now()`, `source: "proxy"`, `version: "1"` — envelope-shape padding on a message that is logically a control. Done to make the same message parse as envelope in some paths and control in others.
- Impact: Reinforces the `session_list` collision above. The schema says these fields aren't required for control; the proxy emits them anyway to appease the parser ambiguity.
- Fix approach: Decide whether these are control or envelope, pick one schema, delete the padding.

**Proxy-to-client allowlist is a single-source-of-truth trap**
- Severity: **MED**
- File: `apps/relay/src/handlers/proxy.ts:10-26`
- Evidence: Hand-maintained `PROXY_TO_CLIENT_TYPES = new Set([...])`. A new control message emitted by proxy that is not added here is silently dropped by relay (`logger.warn({ type }, "Unexpected control message from proxy")` at L175 — a warning, not an error, and not surfaced to the developer).
- Evidence of history: MEMORY.md references this as a known trap (`[Relay control allowlist]` — "proxy→client 新 control type 必须加到 PROXY_TO_CLIENT_TYPES，否则 relay 不转发").
- Impact: Every proxy/shared-schema change risks silent forwarding failure until noticed via manual testing. Zero compile-time check.
- Fix approach: Derive the allowlist from the Zod schema (tag each control type with a direction metadata) or split `RelayControlSchema` into `ProxyToRelaySchema`, `ProxyToClientSchema`, `ClientToRelaySchema`, `ClientToProxySchema` so TS enforces routing.

**Duplicate message parsing on relay hot path**
- Severity: **MED**
- File: `apps/relay/src/router.ts:41-72`
- Evidence: `handleProxyConnection` at `apps/relay/src/handlers/proxy.ts:106` calls `parseMessage(raw)`, then for envelopes at L188 calls `routeProxyMessage(raw, ...)` which at `router.ts:47` calls `parseMessage(raw)` **again**. Zod's discriminatedUnion walk is not free; this doubles it per envelope.
- Impact: Wasted CPU on the relay for every PTY-adjacent envelope (assistant_message, session_status, tool_use_request, thinking). At scale this is the relay's throughput bottleneck.
- Fix approach: Pass the already-parsed result down instead of re-parsing; change `routeProxyMessage(raw, ...)` to take `message: MessageEnvelope`.

## Dead Code

**`FileWatcher` + `dir-lister` orphaned**
- Severity: **MED**
- Files: `apps/proxy/src/file-watcher.ts` (152 lines), `apps/proxy/src/dir-lister.ts` (54 lines)
- Evidence: `FileWatcher` class is exported but has zero importers outside `file-watcher.ts` itself. `listDirectory` / `WATCH_BLACKLIST` / `isBlacklistedPath` are imported only by `file-watcher.ts`. `apps/proxy/src/handlers/control-messages.ts:49` has its own parallel `scanDir` with a DIFFERENT blacklist (`HIDDEN_ENTRY_NAMES = new Set(["node_modules"])`) that is actually used.
- Evidence in STATE.md L83: `Phase 10: FileWatcher integration into Chat page file picker` is flagged as pending TODO.
- Impact: 200+ lines of untested branching logic; the two directory-listing implementations will drift further apart if FileWatcher is ever wired up.
- Fix approach: Either integrate FileWatcher and delete `scanDir`, or delete `file-watcher.ts` + `dir-lister.ts` and stop planning the integration.

**`tool_result` envelope + `addToolCall` / `updateToolResult` / `setWorkingTool` / `toggleToolCollapse` are never called**
- Severity: **MED**
- Files:
  - Schema: `packages/shared/src/schemas/tool.ts:31-37` (ToolResultPayloadSchema)
  - Envelope: `packages/shared/src/schemas/envelope.ts:72-76`
  - Web handler: `apps/web/src/services/chat-dispatcher.ts:40-46` (handleToolResult)
  - Store: `apps/web/src/stores/chat-store.ts:60-65, 137-180, 199-201` (addToolCall, updateToolResult, toggleToolCollapse, setWorkingTool, ToolCallInfo, workingToolName)
- Evidence: `grep -rn "tool_result" apps/proxy/src --include="*.ts" | grep -v __tests__` returns empty. Proxy never emits `tool_result` envelopes. The handler `handleToolResult` at chat-dispatcher.ts:40 can never fire in production.
- Evidence: `grep "addToolCall\|setWorkingTool\|updateToolResult" apps/web/src --include="*.tsx" | grep -v test | grep -v "chat-store.ts"` returns zero component callers.
- Impact: ~150 lines of store infrastructure (plus corresponding test coverage) maintains a feature that doesn't exist. Confuses readers who think tool call threads are a thing.
- Fix approach: Either wire proxy to emit `tool_result` envelopes (turns the code live), or delete ToolResult schema, envelope entry, dispatcher handler, and all four store methods. The chat-store test `addToolCall + updateToolResult scoped to message` at chat-store.test.ts:103 must go with it.

**`quotedMessage` state + `QuotePreviewBar` display**
- Severity: **LOW**
- Files: `apps/web/src/stores/chat-store.ts:49, 204-207` (quotedMessage slice + setQuotedMessage), `apps/web/src/components/chat/quote-preview-bar.tsx`
- Evidence: `grep "setQuotedMessage(" apps/web/src --include="*.tsx" --include="*.ts" | grep -v test | grep -v chat-store.ts` → only `quote-preview-bar.tsx:30` which calls it with `null` (cancel). Nothing sets a non-null quote, so `QuotePreviewBar` can never render its content.
- Impact: A UI primitive and its store slice that are reachable in no user flow.
- Fix approach: Delete QuotePreviewBar, remove quotedMessage from chat-store, remove the `<QuotePreviewBar>` rendering at chat.tsx:91.

**Debug pages ship in production bundle**
- Severity: **LOW**
- Files: `apps/web/src/lib/router.tsx:22-24`, `apps/web/src/pages/pty-test.tsx` (175 lines), `apps/web/src/pages/token-showcase.tsx` (239 lines), `apps/web/src/pages/markdown-test.tsx`
- Evidence: Router unconditionally registers `/pty-test`, `/tokens`, `/markdown-test` routes. No `import.meta.env.DEV` guard.
- Impact: Bundle bloat, exposes internal design token grid to any end user who types the URL.
- Fix approach: Gate under `if (import.meta.env.DEV)` route list, or move these into a separate dev entry.

**`ToolApprovalCard` localStorage whitelist is vestigial**
- Severity: **LOW**
- File: `apps/web/src/components/chat/tool-approval-card.tsx:52-72`
- Evidence: `readWhitelist` is defined and called only from `addToWhitelist` (for dedup). It is never read to short-circuit future approvals. The only function of the localStorage is: remember that `whitelistTool: true` was previously chosen, for nothing.
- Impact: Misleading name suggests it affects approval behaviour; it doesn't. Future reader will assume it does.
- Fix approach: Delete `readWhitelist`/`addToWhitelist`/`whitelistKey` and the localStorage write — the server-side whitelist sent via `worker_whitelist_add` does the real work.

**`command-store.lastUpdated` set but never read**
- Severity: **LOW**
- File: `apps/web/src/stores/command-store.ts:8, 19`
- Evidence: `lastUpdated` is assigned on every `setCommands` but nothing consumes it.
- Fix approach: Delete the field.

**`proxyListLoaded`, unused `filePath` code path in status**
- Severity: (skipped — too minor to itemize)

## Silent Fallbacks

**32+ `catch {}` blocks that swallow errors**
- Severity: **HIGH**
- Files (partial list, all real):
  - `apps/proxy/src/relay-connection.ts:126` — non-JSON message on relay socket silently dropped
  - `apps/proxy/src/serve.ts:111` — `isProcessAlive` catches `EPERM` and returns false (benign)
  - `apps/proxy/src/serve.ts:401, 760, 768, 783, 1163, 1166` — various unlinkSync failures with no context
  - `apps/proxy/src/pty-manager.ts:89, 126, 133` — stdin raw mode / child.kill swallowed
  - `apps/proxy/src/command-discovery.ts:78, 94, 109, 124, 145` — readdir/readFile silently returns `[]`
  - `apps/proxy/src/session-history.ts:23, 33, 52, 83, 92, 115, 200` — JSON parse of Claude history silently discards malformed lines
  - `apps/proxy/src/file-watcher.ts:53` — `watch()` failure silently exits `start()`
  - `apps/proxy/src/handlers/control-messages.ts:69, 80` — scanDir failures hidden from client (but do emit an `error` field to user, OK)
  - `apps/proxy/src/ipc-protocol.ts:272` — WorkerMessage JSON parse failure dropped
  - `apps/proxy/src/json-session.ts:196, 216` — Claude stdout non-JSON lines and isAlive EPERM dropped
  - `apps/proxy/src/seq-counter.ts:39` — seq file load corruption silently resets to 0 (observable data loss)
  - `apps/proxy/src/terminal.ts:211` — reconnect loop swallows every attempt's error
  - `apps/proxy/src/session-manager.ts:192` — EPERM on isProcessAlive OK, but combined with PID reuse could let a dead session look alive if the OS reassigns the PID
  - `apps/web/src/components/chat/input-bar.tsx:43, 51` — localStorage access errors dropped
  - `apps/web/src/components/chat/tool-approval-card.tsx:60` — localStorage JSON parse errors dropped
  - `apps/relay/src/router.ts:22` — Invalid JSON already returns a typed ParseResult (OK)
  - `apps/relay/src/handlers/proxy.ts:210` — already-offline transition error swallowed (benign per comment)
- Impact: When things go wrong (disk full, permission issue, corrupted Claude history file, malformed upstream event), the user sees nothing. Correctness bugs are invisible. Per MEMORY.md `[Log actual outcomes]`, `[No fallback routing]`, this pattern is explicitly banned by the user — yet the codebase is pervaded by it.
- Fix approach: Categorize each catch: (1) expected benign (EPERM on self, already-unlinked), add a one-liner comment justifying + `logger.debug`; (2) unexpected, `logger.warn({error})` at minimum; (3) caller-visible failure, throw. Bulk lint: `eslint no-empty` is insufficient because all these catches have trivial comments; a custom rule forbidding `catch { ... }` without logging or rethrow would be more effective.

**`terminal.ts` reconnect exhaustion leaves PTY as local-only with no user indication**
- Severity: **MED**
- File: `apps/proxy/src/terminal.ts:176-216`
- Evidence: After `maxRetries = 60` (≈5 minutes of retries), `log.error({ maxRetries }, "Reconnection exhausted")` and **the function returns normally**. The PTY keeps running, the user's terminal keeps working locally, but every subsequent `socket.write(...)` at L255 (binary frame push) is silently gated by `socket.writable` check which fails quietly. No stderr, no OSC bell, no visible degradation.
- Impact: User thinks their remote session is mirrored when it isn't. This is the exact "silent fallback" pattern called out in MEMORY.md `[Log actual outcomes]`.
- Fix approach: Emit a one-line stderr warning via `process.stderr.write("\n[cc-anywhere] relay disconnected, local terminal unaffected, remote viewing unavailable\n")` and/or an OSC 9 bell so the Claude Code CLI can surface it. Keep retrying forever on a slow schedule.

**PTY binary frame dropped silently when relay offline**
- Severity: **MED**
- File: `apps/proxy/src/relay-connection.ts:183-188`
- Evidence: `sendBinary` only sends when `SYNCED`, otherwise drops. Comment says "binary 帧无队列，断线丢弃". This is a deliberate design choice for memory safety (PTY stream is too fast to queue), but combined with the silent `terminal.ts` failure mode above, the user has no signal that data is being lost.
- Impact: A disconnect + reconnect cycle leaves the server-side xterm state missing arbitrary chunks; the snapshot mechanism at `serve.ts:671 (pty_snapshot)` / `session_subscribe` is supposed to paper over this, but requires the web client to re-subscribe to get a fresh snapshot. If no client is watching during the gap, nothing triggers re-sync and the next client to open will get out-of-date state.
- Fix approach: On reconnect, proxy should proactively emit `pty_snapshot` for every active PTY session so any connected client sees a consistent view. Currently the proxy waits for `session_subscribe`.

**Worker approval disconnect → deny**
- Severity: **LOW**
- File: `apps/proxy/src/serve.ts:323-342`
- Evidence: On `workerSocket.close` or `error`, all pending approvals resolve `{behavior: "deny", message: "Worker disconnected"}`. Claude CLI then replies "denied by user".
- Impact: A network blip during tool use denies the tool; user gets "denied" with no context that their connection dropped.
- Fix approach: Differentiate denial reason in UI (today "Denied by remote user" is conflated with "Worker disconnected").

## Error Surface / Recovery Gaps

**Worker respawn on process crash is not implemented**
- Severity: **HIGH**
- File: `apps/proxy/src/session-manager.ts:171-186` (`reap`)
- Evidence: When the reaper finds a JSON worker process has died (PID not alive), it calls `terminateSession(id)` which deletes the session from the map. The PTY session has the same path: `serve.ts:713-742` on socket close, when the terminal process is dead, cleans up the session.
- Impact: If `claude` CLI crashes mid-turn (OOM, segfault in stream-json parser), the JSON session disappears. The remote client sees `session_status` terminated and must recreate. There is no automatic respawn with the captured `claudeSessionId` (which IS persisted; see `sessionManager.setClaudeSessionId` at serve.ts:317). So the data for resume exists but is never used to auto-heal.
- Fix approach: On crash detection, attempt to respawn worker with `--resume=claudeSessionId` at least once before terminating.

**No structured shutdown of outstanding tool approvals on serve.ts restart**
- Severity: **MED**
- File: `apps/proxy/src/serve.ts:1152-1173` (`shutdown`)
- Evidence: `shutdown` destroys worker sockets and closes server. It does NOT drain `pendingToolApprovals`. Workers holding `approvalStrategy` promises at JsonSession side get their sockets closed (`session-worker.ts:134`) and set `serveSocket = null`, but the promise remains unresolved. If session-worker itself stays alive (which it does — serve shutting down doesn't kill workers), the approval sits forever.
- Impact: After a `cc-anywhere serve restart`, a session that was in WAITING_APPROVAL has an orphaned Claude process waiting for a `can_use_tool` control response that will never come.
- Fix approach: On shutdown, send `worker_stop` to each worker to kill cleanly, OR explicitly resolve all pending approvals to `deny` before closing.

**Relay has no max-age for offline proxies**
- Severity: **MED**
- File: `apps/relay/src/registry.ts:55-64` (`markProxyOffline`), comment L56: "不设超时"
- Evidence: Offline proxies and their session sets persist in the registry forever. Only `cleanupProxy` removes them, and it's called on `proxy_disconnect` (graceful) not on `proxy_close` (connection drop). The registry leaks across relay lifetime.
- Impact: Long-running relay accumulates dead proxyIds + sessions in memory. `listProxiesWithName` returns them all. The web UI's proxy picker grows unbounded. Memory grows monotonically.
- Fix approach: Add a TTL (e.g., 24h since `disconnectedAt`), run a sweeper in relay heartbeat.

**Binary frame `MAX_BINARY_FRAME_SIZE = 10MB` — no per-second rate limit**
- Severity: **LOW**
- File: `apps/relay/src/handlers/proxy.ts:7`
- Evidence: Per-frame size cap but no bandwidth cap. A misbehaving proxy (or one intentionally flooding) can saturate the relay connection.
- Impact: DoS vector for a public relay.
- Fix approach: Token bucket per proxyId if this becomes a public multi-tenant product.

## Security Concerns

**`/client` WebSocket endpoint has zero authentication**
- Severity: **HIGH**
- File: `apps/relay/src/server.ts:75-80`
- Evidence: `if (pathname === "/client") { clientWss.handleUpgrade(...) }`. No token check (compare to `/proxy` at L59-68 which enforces `?token=`).
- Attack surface once an attacker connects as a `/client`:
  1. `proxy_list_request` → full list of proxyIds + names + session IDs (`apps/relay/src/handlers/client.ts:116-126`)
  2. `proxy_select` with any proxyId → binds to it (`client.ts:148-178`)
  3. `session_create` cwd=/etc → spawns a Claude session on the victim's laptop in that directory (proxy blindly accepts, `serve.ts:910-982`)
  4. `user_input` → send any prompt to the session
  5. `dir_list_request` / `session_resources_request` → enumerate the victim's filesystem (proxy only checks `isPathSafe` for absolute+no-traversal; `/home/victim` is "safe")
  6. `session_messages_request` → read history of any Claude session
- Impact: For any publicly-reachable relay, a third party who knows or guesses a proxyId (21-char nanoid, not secret — leaked via `/api/proxies` HTTP endpoint) gets **remote code execution on the proxy owner's laptop** via Claude Code. This is the single most serious issue in the codebase.
- Fix approach: Either (a) require `?token=` on `/client` too (user-scoped token set at proxy pairing time), or (b) add a per-proxy pairing handshake where the proxy owner approves new client bindings on first contact. A QR-code-based pairing is the usual UX.

**`/api/status`, `/api/proxies`, `/api/clients` are unauthenticated**
- Severity: **HIGH**
- File: `apps/relay/src/health.ts:24-45`
- Evidence: Express routes registered with no middleware. `/api/proxies` returns full proxy list including names and associated session IDs. `/api/clients` returns all clientIds and their bindings.
- Attack surface: An attacker doesn't even need to guess proxyIds — `curl https://relay.example.com/api/proxies` lists them all, then attacker connects to `/client` (no auth, see above) and binds.
- Impact: Reconnaissance for the RCE above becomes trivial. This is effectively an IDOR from day zero.
- Fix approach: Gate `/api/*` behind a relay admin token (separate from proxy token). `/health` can stay public; `/status` counts-only might stay public; everything with identifying info must be gated.

**Path traversal defense is shallow**
- Severity: **MED**
- File: `apps/proxy/src/handlers/control-messages.ts:27-34` (`isPathSafe`)
- Evidence: Only checks `isAbsolute(path)` and `!normalized.includes("..")`. Does NOT check that the path is under a session-scoped root. A client that is authenticated (via relay binding) can request `/etc`, `/root`, `/home/victim/.ssh`, and get directory listings back.
- Impact: Combined with unauthenticated /client above, any attacker can enumerate the proxy owner's filesystem. Even with authentication, the client web SPA is supposed to be a "session remote control", not a general-purpose filesystem browser. An XSS in the web SPA (or a compromised browser) becomes full FS read.
- Fix approach: Constrain `dir_list_request` to paths under `session.cwd` (or under `$HOME` with additional user opt-in). Reject requests whose resolved realpath escapes the allowed root.

**`filterClaudeEnvVars` filters only `CLAUDECODE*` prefix**
- Severity: **LOW**
- File: `apps/proxy/src/json-session.ts:80-88`
- Evidence: Comment says "避免泄漏到 claude 子进程". But CC Anywhere's own `RELAY_URL`, `RELAY_PROXY_TOKEN` env vars (set by the user) are passed through to Claude as-is. If Claude Code decides to log or echo env on startup, the relay token leaks into session logs.
- Impact: Minor; a trust boundary issue. Not a live leak today but tight coupling.
- Fix approach: Also filter `RELAY_*`, `CC_ANYWHERE_*` before spawn.

**`proxyId` file `~/.cc-anywhere/proxy-id` has no ACL check**
- Severity: **LOW**
- File: `apps/proxy/src/relay-connection.ts:69-85`
- Evidence: `writeFileSync(idPath, id, "utf-8")` with no explicit mode. Default mode from umask (typically 0644). A multi-user machine leaks the proxyId to other local users.
- Impact: On a shared laptop, another user can read it and bind a `/client` session. Combined with the /client unauthenticated issue, this becomes a local-to-remote escalation.
- Fix approach: `writeFileSync(idPath, id, { mode: 0o600 })`; chmod existing file on load.

## Cross-Cutting Coupling

**Any change to proxy→client message types requires touching 4 places**
- Severity: **MED** (structural, not a bug)
- Files (for every new message type):
  1. `packages/shared/src/schemas/relay-control.ts` — add schema entry
  2. `apps/proxy/src/serve.ts` — emit the message
  3. `apps/relay/src/handlers/proxy.ts:10-26` — add to `PROXY_TO_CLIENT_TYPES`
  4. `apps/web/src/services/{chat,session,resource}-dispatcher.ts` — handle on client
  5. Plus `packages/shared` rebuild (memory note `[Shared 包 rebuild]`)
- Impact: Every protocol change is a manual 4-step checklist. At least one step (#3) has no compile-time guard — relay silently drops unregistered types.
- Fix approach: See "Proxy-to-client allowlist" above. A directionally-typed schema union generates the allowlists automatically.

**Shared package build is a runtime landmine**
- Severity: **MED**
- Evidence: MEMORY.md `[Shared 包 rebuild]` — "改 shared schema 后必须跑 pnpm --filter shared run build（tsup 出 JS），否则 relay/proxy 运行时用旧 JS".
- Impact: Developers who forget the rebuild ship stale schemas. Tests on source may pass while runtime fails.
- Fix approach: Change `package.json` exports to point to `src/*.ts` with `"types": "./src/index.ts"` and use `tsx`/`ts-node` or a workspace-aware bundler (tsdown) that handles this transparently. Alternatively, a pre-commit hook that detects schema changes and runs `pnpm -r build`.

**Proxy's outbound session_list sends a full envelope-shaped payload every time any session changes**
- Severity: **LOW**
- File: `apps/proxy/src/serve.ts:603-614, 635-646, 728-740, 958-968, 1041-1051, 1079-1088`
- Evidence: Six separate sites that rebuild the full session list and send it. No diff, no last-value check.
- Impact: Bandwidth waste, client re-renders entire list on every session state change.
- Fix approach: One `broadcastSessionList()` helper; consider per-session delta (`session_status` already covers state changes).

## Protocol Drift

**Stack doc claims Zod `^3.24`; reality is Zod `^4.3.6`**
- Severity: **LOW**
- Files: `CLAUDE.md` (stack section L45), `packages/shared/package.json:23`, `apps/proxy/package.json:56`, `apps/relay/package.json:56`
- Evidence: Literal dependency strings differ.
- Impact: Doc is misleading. Zod 4 has subtle behaviour changes from 3 (error format, parseAsync semantics).
- Fix approach: Update CLAUDE.md, or if Zod 4 was unintentional, downgrade.

**`session_status` envelope — `lastActive` documented optional for "compat" but always set**
- Severity: **LOW**
- File: `packages/shared/src/schemas/session.ts:54-59`
- Evidence: Comment L54 says "proxy 侧总会填，留 optional 为兼容旧 payload". No current code path emits without it. The optionality is dead — nobody needs backward compat anymore since the protocol isn't publicly versioned.
- Fix approach: Make it required. One less branch in every consumer.

**`SessionInfo.mode` and `.name` optional but proxy always sets them**
- Severity: **LOW**
- File: `packages/shared/src/schemas/session.ts:17-19`
- Similar to above. Adds `...(s.name !== undefined ? { name: s.name } : {})` boilerplate at 6+ call sites in serve.ts.

## Config/Env Sprawl

**`process.env.HOME` with no fallback will produce `"undefined/.cc-anywhere"`**
- Severity: **MED**
- Files:
  - `apps/proxy/src/paths.ts:4` — `${process.env.HOME}/.cc-anywhere`
  - `apps/proxy/src/config.ts:3` — `${process.env.HOME}/.cc-anywhere/config.json`
  - `apps/relay/src/index.ts:5` — `${process.env.HOME}/.cc-anywhere/relay-data`
  - `apps/relay/src/server.ts:38` — fontsDir fallback same pattern
- Evidence: Template strings without guard. If `HOME` is unset (Docker without passing HOME, Windows `USERPROFILE` instead, certain CI runners), these resolve to literal `undefined/.cc-anywhere`.
- Contrast: `relay-connection.ts:11-13` DOES handle this correctly: `process.env.HOME ?? process.env.USERPROFILE ?? "."`.
- Impact: Subtle cross-platform breakage. Silent creation of garbage directories. Different fallback behaviour across the same codebase.
- Fix approach: One `getCcHome()` helper in shared, use everywhere.

**`cwd.replace(process.env.HOME || "", "~")` replaces empty string with `~`**
- Severity: **LOW**
- Files: `apps/proxy/src/serve.ts:914`, `terminal.ts:197, 222`
- Evidence: When `HOME` is unset, `"/tmp/foo".replace("", "~")` yields `"~/tmp/foo"` (prepends `~`), not `"/tmp/foo"` unchanged as likely intended.
- Impact: Session names look like `~/tmp/foo` when HOME is unset — wrong but not broken.
- Fix approach: Guard: `const home = process.env.HOME; return home ? cwd.replace(home, "~") : cwd;`.

**`CLAUDE_BIN`, `CC_ANYWHERE_PROXY_NAME`, `RELAY_URL`, `RELAY_PROXY_TOKEN`, `INIT_CWD`, `PORT`, `DATA_DIR`, `HEARTBEAT_INTERVAL`, `LOG_LEVEL`, `TEST_SCOPE`, `VITEST`, `WEB_BASE_URL`, `TERM`, `USERPROFILE` — zero central documentation**
- Severity: **LOW**
- Evidence: Env vars scattered across 8+ files. No `env.d.ts` declaring them. README only mentions `RELAY_URL` and `RELAY_PROXY_TOKEN`.
- Impact: New contributor can't tell which vars are supported or what they do.
- Fix approach: Single `packages/shared/src/env.ts` with documented schema + `envalid`-style parse at startup.

## Test Gaps

**No test for binary WebSocket frame path (the primary PTY data path)**
- Severity: **HIGH**
- Files exercised:
  - `apps/proxy/src/terminal.ts:245-270` (tap → `encodeBinaryIpcFrame` → serve socket)
  - `apps/proxy/src/ipc-protocol.ts:10-25` (`encodeBinaryIpcFrame`)
  - `apps/proxy/src/ipc-protocol.ts:288-347` (`createIpcReader` drain state machine)
  - `apps/proxy/src/serve.ts:691-701` (onBinaryFrame → WebSocket binary)
  - `apps/relay/src/handlers/proxy.ts:79-102` (binary frame forwarding with zero-copy header)
  - `apps/web/src/services/websocket.ts:126-136` (dispatchBinary)
  - `apps/web/src/components/chat/chat-pty-view.tsx:93-100` (subscribeBinary → xterm.write)
- Evidence: `ipc-protocol.test.ts` exists and tests NDJSON; `terminal-data-flow.test.ts` covers the tap. Looking at coverage — there is no integration test that pushes a binary frame through **the whole chain** end-to-end.
- Impact: This is the hottest, most performance-sensitive, most invariant-sensitive path (header length bytes, zero-copy assumption, UTF-8 sessionId encoding). Regression risk on every touch.
- Fix approach: One integration test that fires up proxy + relay + web mock, sends N binary frames with known content, asserts xterm buffer state.

**No test for PTY lifecycle crash recovery**
- Severity: **HIGH**
- Evidence: `pty-manager.test.ts`, `session-manager.test.ts` exist but test individual units. The crash scenarios in STATE.md (D-28, D-42, D-46) aren't backed by tests:
  - Claude CLI process OOM mid-turn
  - terminal.ts process killed while serve running
  - serve restarted while terminal alive (the `socket.on("close")` branch at `serve.ts:713-742`)
  - worker socket close with pending approvals
- Impact: Every lifecycle edge was found in production and fixed by patches; without tests, they'll regress.

**No test for replay / snapshot / scrollback reconstruction**
- Severity: **MED**
- Evidence: STATE.md L85 "Phase 11: Scrollback cleanup for resize-triggered duplicate frames". `session_subscribe` → `pty_snapshot` roundtrip at `serve.ts:1111-1119` has no test.
- Impact: Replay/snapshot is what makes reconnection feel seamless; a regression here makes remote viewing unreliable.

**Shared package has zero tests**
- Severity: **MED**
- Evidence: `ls packages/shared/src/__tests__/` returns nothing. No schema round-trip tests, no builder tests.
- Impact: Schema changes land without regression coverage. Zod 3→4 migration happened without tests to validate.

**Web: only e2e + a couple of unit tests; no test for chat-dispatcher, session-dispatcher, phase-machine**
- Severity: **MED**
- Evidence: Test files listed at `apps/web/src/**/*.test.{ts,tsx}` — message-bubble, markdown-view, ansi-keys, theme-tokens, chat-store. Zero for dispatchers or phase-machine.
- Impact: The state machine at `phase-machine.ts:21-204` encodes 6 phases × N events = many transitions. All untested.

## Other Concerns (from the hot-file analysis)

Top churn last 100 commits:
```
 13 apps/web/src/components/chat/chat-json-view.tsx
 11 apps/web/src/components/session/session-list.tsx
 10 apps/web/src/pages/chat.tsx
 10 apps/web/src/components/chat/input-bar.tsx
 10 apps/web/src/components/chat/file-path-picker.tsx
 10 apps/web/src/components/chat/chat-pty-view.tsx
  8 scripts/install-relay.sh
  7 apps/proxy/src/serve.ts
  6 packages/shared/src/schemas/relay-control.ts
```

**`apps/web/src/components/chat/chat-pty-view.tsx` (415 lines, 10 commits)** — hot file doing sub-pixel scroll synchronization, autoscale font resize, sticky canvas trick, ResizeObserver stacking. The comment block at the top (L1-L15) acknowledges the complexity. The `useEffect` at L173 ties DOM layout state to xterm internals; `syncing` flags and `pendingNewFrameRef` work around feedback loops. This code is brittle by necessity — xterm.js is tight — but the complexity is concentrated in one function. Any change requires careful manual verification per MEMORY.md `[UI/UX needs approval]`.

**`apps/proxy/src/serve.ts` (1183 lines, 7 commits)** — covered above. The dominant tech debt sink.

**`packages/shared/src/schemas/relay-control.ts` (6 commits)** — the accretion of new control message types without refactoring is why it now has 280 lines of discriminatedUnion. Per-category split (ProxyToClient, ClientToProxy, Request/Response pairs) would be easier to maintain.

---

*Concerns audit: 2026-04-20*
