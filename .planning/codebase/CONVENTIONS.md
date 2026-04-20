# Coding Conventions

**Analysis Date:** 2026-04-20

## TypeScript Configuration

**Strictness:** `"strict": true` in `tsconfig.base.json` — full strict mode enabled for all workspaces.

**Key compiler options (`tsconfig.base.json`):**
- `"target": "ES2022"`, `"module": "ESNext"`, `"moduleResolution": "bundler"`
- `"verbatimModuleSyntax": true` — `import type` required for type-only imports (rules out namespace imports mixing values/types)
- `"isolatedModules": true`, `"composite": true` — project references across workspaces
- `"esModuleInterop": true`, `"forceConsistentCasingInFileNames": true`

**Workspace type-check command:** `pnpm typecheck` at root runs `tsc -b` across all composite projects. Each app/package also exposes `typecheck` script.

**Stale project reference:** `tsconfig.json` still lists `{ "path": "apps/feishu" }` but the `apps/feishu/` directory does not exist — dead reference, `tsc -b` will fail if not removed or the directory re-added.

## Linting & Formatting

**ESLint (`eslint.config.js`):** Flat config, `typescript-eslint` with `projectService: true` (typed linting).
- Extends `js.configs.recommended` + `tseslint.configs.recommended` + `eslint-config-prettier`
- `@typescript-eslint/no-unused-vars`: error, `argsIgnorePattern: "^_"`
- `@typescript-eslint/explicit-function-return-type`: off (inferred returns allowed)
- React hooks rules (`react-hooks/rules-of-hooks: error`, `exhaustive-deps: warn`) applied **only** to `apps/web/**/*.{ts,tsx}` — proxy/relay backend not affected.
- Ignored: `dist/**`, `dist-h5/**`, `**/*.config.{ts,js,cjs}`, `reference/**`, `coverage/**`, `.claude/worktrees/**`, `**/scripts/**`.

**Prettier (`.prettierrc`):**
```json
{ "semi": true, "singleQuote": false, "trailingComma": "all", "printWidth": 100, "tabWidth": 2 }
```
Double-quotes, semicolons, trailing commas everywhere, 100-col lines.

**Run commands (root):** `pnpm lint`, `pnpm format`, `pnpm format:check`.

## Naming Patterns

**Files:**
- Source: `kebab-case.ts` / `kebab-case.tsx` (`session-manager.ts`, `relay-connection.ts`, `input-bar.tsx`, `message-bubble.tsx`)
- Tests: `<name>.test.ts` / `<name>.test.tsx`
- Playwright E2E: `<feature>.spec.ts` (`smoke.spec.ts`, `master-detail.spec.ts`) under `apps/web/e2e/`

**Directories:** kebab-case (`handlers/`, `session/`, `components/chat/`). `__tests__/` (double-underscore) used as test folder in proxy/relay/shared.

**Classes:** `PascalCase` — `SessionManager`, `RelayConnection`, `RelayRegistry`, `MemoryMessageQueue`, `SeqCounter`, `LineBuffer`, `ToolWhitelist`, `WebSocketManager`, `RelayClient`, `PtyManager`, `JsonSession`.

**Functions:** `camelCase` — `buildMessage`, `createLogger`, `createRelayServer`, `handleProxyConnection`, `routeProxyMessage`, `parseMessage`, `extractOscSignals`, `encodeBinaryIpcFrame`, `connectToWorker`, `spawnWorker`. React components `PascalCase` (`App`, `MessageBubble`, `ChatPtyView`).

**Hooks:** `use-` prefix file, `useX` export — `use-relay-setup.ts` → `useRelaySetup`, `use-visual-viewport.ts`, `use-sidebar-collapsed.ts`.

**Types & interfaces:** `PascalCase`. Suffixes express intent:
- `...Options` for constructor option bags (`SessionManagerOptions`, `RelayServerOptions`, `RelayConnectionOptions`)
- `...Info` for plain-data records (`SessionInfo`, `ProxyInfo`, `DirEntry`, `HistorySession`)
- `...Payload` for envelope payloads (`UserInputPayload`, `ToolUseRequestPayload`, `AssistantMessagePayload`, `PtyStatePayload`)
- `...Message` for IPC/control message unions (`IpcMessage`, `WorkerMessage`, `RelayControlMessage`, `MessageEnvelope`)

**Constants:** `UPPER_SNAKE` module-level (`MAX_BACKOFF_MS`, `MAX_QUEUE_SIZE`, `PROXY_TO_CLIENT_TYPES`, `IPC_BINARY_MARKER`, `COMMAND_REFRESH_MS`).

**Enum-like objects:** `const Xxx = { FOO: "foo", ... } as const` + `export type Xxx = typeof Xxx[keyof typeof Xxx]` — **not** TS `enum`. See `SessionState` (`packages/shared/src/constants/session.ts`), `ErrorCode` (`packages/shared/src/constants/errors.ts`), `RelayConnectionState` (`apps/proxy/src/relay-connection.ts:24`), `TerminalState` (`apps/proxy/src/terminal.ts:26`).

**Message type strings:** `snake_case` — `"user_input"`, `"tool_use_request"`, `"proxy_register"`, `"session_create_response"`, `"remote_input_raw"`, `"pty_state"`, `"turn_result"`. Consistent for both `MessageEnvelope` types (`packages/shared/src/schemas/envelope.ts`) and `RelayControl` types (`packages/shared/src/schemas/relay-control.ts`).

**Channel / endpoint strings:** lowercase — WebSocket endpoints `/proxy` and `/client` (`apps/relay/src/server.ts:59,75`), static mount `/fonts`, health `/health`.

## Import Organization

**Extensions:**
- Backend (`apps/proxy`, `apps/relay`, `packages/shared`): relative imports use `.js` suffix (ESM runtime requirement) — `import { logger } from "./logger.js"`, `import { MessageEnvelopeSchema } from "./schemas/envelope.js"`.
- Web (`apps/web`): no `.js` suffix; Vite resolves TS directly. `import { App } from "./app"`, `import { cn } from "@/lib/utils"`.

**Path aliases:**
- `apps/proxy/package.json`, `apps/relay/package.json` declare `"imports": { "#src/*": "./src/*" }` — **used only in tests** (`import { ... } from "#src/router.js"`). Source code uses relative imports.
- `apps/web` uses `@/*` → `./src/*` (Vite + tsconfig `paths`). Vitest config mirrors this alias plus `@cc-anywhere/shared` → `packages/shared/src/index.ts`.

**Node builtins:** explicit `node:` prefix everywhere — `import { createServer } from "node:net"`, `import { readFileSync } from "node:fs"`, `import { join } from "node:path"`, `import { EventEmitter } from "node:events"`.

**No import ordering enforced by lint.** Observed convention: node builtins → third-party → workspace packages → relative imports (see `apps/proxy/src/serve.ts:1-39`, `apps/relay/src/server.ts:1-9`).

**No deferred imports as a rule** (CLAUDE.md prohibits lazy imports except for circular deps). Observed violation: `apps/proxy/src/index.ts:153` `const { startTerminal } = await import("./terminal.js")` and similar at `:169, :796`. These are CLI boot-time imports to keep `init`/`status` commands fast; not strictly circular.

## Common Patterns

### Message schemas (zod)

All cross-process messages live in `packages/shared/src/schemas/` and are defined as zod schemas, with types inferred via `z.infer<typeof Schema>`:

```typescript
// packages/shared/src/schemas/chat.ts
export const UserInputPayloadSchema = z.object({ text: z.string().min(1) });
export type UserInputPayload = z.infer<typeof UserInputPayloadSchema>;
```

**Envelope layer (`packages/shared/src/schemas/envelope.ts`):** `MessageEnvelopeSchema` is a `z.discriminatedUnion("type", [...])` over 17 message types grouped as chat / tool / session / system. Shared `BaseEnvelopeFields` (`seq`, `sessionId`, `timestamp`, `source: "proxy"|"client"`, `version`).

**Control layer (`packages/shared/src/schemas/relay-control.ts`):** `RelayControlSchema` — separate `z.discriminatedUnion("type", ...)` for 30+ relay-control messages (registration, routing, directory listing, permission mode, PTY snapshot, etc.). Control messages have **no `seq`** and are never buffered.

**Parsing:** `apps/relay/src/router.ts:parseMessage` tries `RelayControlSchema.safeParse` first, then `MessageEnvelopeSchema.safeParse`, returning `{ kind: "control" | "envelope" | "invalid" }`.

**Builder:** `packages/shared/src/builders/index.ts` exposes `buildMessage(type, sessionId, seq, payload, source)` which validates via `.parse()` at construction time.

### State machines

Explicit transition tables with validation:

```typescript
// apps/proxy/src/session-manager.ts:28
const VALID_TRANSITIONS: Record<SessionState, Set<SessionState>> = {
  [SessionState.IDLE]: new Set([WORKING, ERROR, TERMINATED]),
  [SessionState.WORKING]: new Set([IDLE, WAITING_APPROVAL, ERROR, TERMINATED]),
  [SessionState.ERROR]: new Set([TERMINATED]),
  [SessionState.TERMINATED]: new Set(),
  // ...
};
// updateState throws on illegal transition
```

Same pattern in:
- `apps/relay/src/registry.ts:67` — `transitionProxy(from, to)` / `transitionClient(from, to)` throw on mismatch.
- `apps/proxy/src/relay-connection.ts:24` — `RelayConnectionState` const object + `private transition(to)` method logging from→to.
- `apps/proxy/src/terminal.ts:26` — `TerminalState` const object.

### Event emitters

`RelayConnection extends EventEmitter` (`apps/proxy/src/relay-connection.ts:44`) — emits `"sync"`, `"connected"`, `"disconnected"`, `"message"`. Consumers use `relayConnection.on("message", ...)`.

Web side uses observer pattern (no Node EventEmitter in browser): `WebSocketManager` (`apps/web/src/services/websocket.ts`) exposes `onMessage(handler)` / `onStatusChange(handler)` / `subscribeBinary(sessionId, handler)` returning unsubscribe functions. `RelayClient` wraps this with its own `messageHandlers: Set<...>`.

### Logging (pino)

**Shared factory:** `packages/shared/src/logger.ts` exports `createLogger({ name, level?, logDir?, stdout?, silent? })`:
- Writes to `~/.cc-anywhere/logs/<name>.log` by default.
- `silent: true` → `pino({ level: "silent" })` — used in tests.
- `stdout: true` → dual-stream file + stdout.

**Proxy usage (`apps/proxy/src/logger.ts`):** two named loggers, `service` and `terminal`, both auto-silent when `process.env.VITEST` is set.

**Relay usage (`apps/relay/src/index.ts:11`):** one `relay` logger with `stdout: true` (container logs) and `level: process.env.LOG_LEVEL ?? "info"`.

**Web:** no pino. Uses `console.warn` / `console.error` for service-layer diagnostics (`apps/web/src/services/relay-client.ts:24,40`, `apps/web/src/services/websocket.ts:33`). No structured logging.

**Structured log style (pino convention):** object first, message string second:
```typescript
logger.info({ sessionId, mode, name }, "Session created");
logger.warn({ proxyId, error: result.error }, "Invalid message from proxy");
```
Consistent across proxy and relay — context goes into the object, human-readable verb phrase into the message.

**Log messages in English** per `/Users/admin/CLAUDE.md` mandate. Comments and docstrings in Chinese. Verified across `apps/proxy/src/serve.ts`, `apps/relay/src/handlers/proxy.ts` — all log strings English.

**Console.log in production paths (violations of pino convention):**
- `apps/proxy/src/index.ts` — uses `console.log`/`console.error` intentionally for CLI output (status command, init command); this is user-facing stdout, not debug logging. Acceptable.
- `apps/proxy/src/serve.ts:123,137` — `console.error` duplicated with `logger.error` on fatal startup conditions; acceptable redundancy.
- `apps/proxy/src/session-worker.ts:34` — `console.error` on argv parse failure before logger available.
- `apps/proxy/src/ipc-protocol.ts` — uses `console` for schema validation errors.

### Error handling

**Policy:** `throw` for programmer errors and invariants; validation/network/protocol errors resolved to explicit response messages. **No `Result<T, E>` pattern anywhere** — only 1 grep hit and it's in `apps/web/src/pages/markdown-test.tsx`, unrelated to error handling.

**Throws (15 occurrences in proxy, 8 in relay):**
- State machine violations: `SessionManager.updateState` throws `Error("Invalid state transition: X -> Y")`, `RelayRegistry.transitionProxy` throws on state mismatch.
- Missing entities: `SessionManager.updateState`/`setClaudeSessionId` throw `Error("Session not found: ${id}")`.
- Persistence corruption: `SessionManager.load` wraps `JSON.parse` failure with `new Error(..., { cause: err })`.

**Silent try/catch for known benign failures:** common pattern, always with an inline comment explaining why:
```typescript
// apps/proxy/src/serve.ts:760
try { unlinkSync(STOPPED_PATH); } catch {
  // STOPPED 文件不存在时忽略
}
```
60+ `try { ... }` blocks in proxy, nearly always short and intention-commented.

**Protocol-layer errors as messages (relay):** `parseMessage` returns `{ kind: "invalid", error }`; handlers respond to peer with `{ type: "relay_error", code, message }` rather than throwing. Codes defined ad-hoc per-site (`"NOT_REGISTERED"`, `"PROXY_OFFLINE"`, `"INVALID_MESSAGE"`, `"NOT_BOUND"`, `"UNSUPPORTED"`, `"INVALID_RANGE"`) — **not** imported from `ErrorCode` in `packages/shared/src/constants/errors.ts`. The shared `ErrorCode` enum is currently unused by any relay handler.

**Async error handling:** all async functions use `async/await` + `try/catch`. No `.then().catch()` chains in production code (except one spot in `apps/proxy/src/serve.ts:983-991` to keep history load non-blocking).

### Async patterns

- Native `async/await` throughout.
- Explicit `Promise` wrappers for callback-based APIs: `tryConnect`, `waitForMessage`, `waitForOpen` (`apps/relay/src/__tests__/helpers.ts`).
- No `setImmediate` / `process.nextTick` — backoff via `setTimeout` with exponential base (`apps/proxy/src/relay-connection.ts:164`).
- Full jitter: `Math.random() * Math.min(MAX, BASE * 2^attempt)` for reconnect.

### Comments & docstrings

- **Chinese** per `/Users/admin/CLAUDE.md`; some JSDoc-style `/** ... */` block comments (see `apps/proxy/src/seq-counter.ts:4-8`, `apps/relay/src/__tests__/helpers.ts:4-17`) — minority style.
- Single-line `//` comments dominate; describe invariants and non-obvious WHY, not HOW (per memory `feedback_no_diary_comments`).
- Inline comments often cite plan/phase references: `// D-06: binary PTY 数据从 terminal 进程转发到 relay`, `// CONTEXT Addendum D-21 方案 A`, `// Phase 9: 滚动由客户端 xterm.js scrollback 直接处理`. Useful for git-archaeology, but couples code to planning docs.
- **No emojis in code** per `/Users/admin/CLAUDE.md`.

### Function design

- Module-level helpers preferred over classes for stateless utilities (`parseMessage`, `routeProxyMessage`, `buildMessage`, `extractOscSignals`, `encodeBinaryIpcFrame`).
- Classes used for stateful long-lived components (`SessionManager`, `RelayConnection`, `RelayRegistry`, `WebSocketManager`).
- Constructor options as single object param: `new RelayConnection(url, { proxyIdPath, name, token })`.
- Default parameters favored over internal `??` fallbacks in signatures.
- Large functions tolerated: `apps/proxy/src/serve.ts` is 1183 lines with a single `startService` function of ~400 lines handling relay-message routing via an `if/else if` chain over 20+ message types (not a map). Switch on `type` field sometimes; other times string equality `if (parsed.type === "X")`.

### Module design

- `packages/shared/src/index.ts` is the **single public re-export barrel**. Consumers always `import { ... } from "@cc-anywhere/shared"`. Other directories (`apps/proxy/src/`, `apps/relay/src/`) expose no barrels — each file imports another directly by relative path.
- `packages/shared/src/types/index.ts` re-exports types from schemas so `import type { UserInputPayload } from "@cc-anywhere/shared/types"` would work, but in practice consumers import from the root barrel.
- Named exports only — no `default export` in library code (one exception: `apps/web/src/lib/router.tsx` is the React Router object, name exported).

## Module Boundary Practices

**What crosses package boundaries (`@cc-anywhere/shared`):**
- All zod schemas (`MessageEnvelopeSchema`, `RelayControlSchema`, payload schemas) and their inferred types.
- `buildMessage` envelope builder.
- `createLogger` factory + `Logger` type (re-exported pino logger).
- Constants: `SessionState`, `ErrorCode`.
- Sub-types surfaced for relay-control: `ProxyInfo`, `DirEntry`, `CommandEntry`, `HistorySession`.

**What stays private (per app):**
- `apps/proxy`:
  - IPC protocol between `terminal` and `serve` processes (`ipc-protocol.ts`) — separate zod schema `IpcMessageSchema`, NOT shared.
  - Worker IPC between `serve` and `session-worker` (`WorkerMessage`) — local only.
  - `SessionManager`, `RelayConnection`, `PtyManager`, `JsonSession`, `LineBuffer`, `SeqCounter`, `ToolWhitelist` — none re-exported.
- `apps/relay`:
  - `RelayRegistry`, `router.ts`, handler modules are private to the server.
  - `server.ts` **is** exposed via `package.json` `"exports": { "./server": "./dist/server.js" }`. Used by `apps/proxy/src/__tests__/integration/relay-connection.test.ts` to spin a real relay for integration testing. Proxy's vitest config aliases `@lichenxi.cat/cc-anywhere-relay/server` → `apps/relay/src/server.ts`.
- `apps/web`: nothing re-exported — it's a leaf application.

**`.js` extension everywhere in backend imports.** Web source code omits the extension.

## Divergence Between apps/proxy and apps/relay

1. **Logger output:** proxy logs to file only by default; relay logs to stdout + file. Proxy's logger silences itself under VITEST; relay does not (tests explicitly pass `silent: true` via `createLogger`).
2. **Error codes:** relay constructs `relay_error` messages with inline string literals (`"PROXY_OFFLINE"`, `"NOT_BOUND"`, etc.); proxy does not emit error messages — it returns IPC `*_response` objects with `error?: string` fields. Shared `ErrorCode` enum unused by either.
3. **Control-message allowlist duplication:** `apps/relay/src/handlers/proxy.ts:10 PROXY_TO_CLIENT_TYPES` and `apps/relay/src/handlers/client.ts:8 CLIENT_TO_PROXY_TYPES` are hardcoded sets. Adding a new relay-control message requires editing both `RelayControlSchema` and the allowlist (see memory `project_relay_control_allowlist`). No runtime enforcement that the sets are consistent with the schema.
4. **Lint rules:** `react-hooks` plugin applied only to `apps/web` (intentional, in eslint.config.js).
5. **TS entry style:** `apps/proxy` has bin entries (`dist/index.js`, `dist/serve.js`, `dist/session-worker.js`); `apps/relay` has `dist/index.js` bin + `dist/server.js` library export. `apps/web` ships via Vite `dist/`.

## Documented vs Followed Conventions

**CLAUDE.md rules & status:**

| Rule | Status | Notes |
|------|--------|-------|
| Log messages in English | Followed | All `logger.*` calls use English strings. |
| Comments/docstrings in Chinese | Followed | Observed throughout. |
| No emojis in code | Followed | No emoji grep hits in source. |
| No diary-style comments | Mostly followed | Some phase/plan references remain (`// Phase 9: ...`, `// D-21 方案 A ...`) — factual but ties code to planning docs. |
| No lazy/deferred imports except for circular deps | **Violated** in `apps/proxy/src/serve.ts` (`await import("./terminal.js")`, `await import("./serve.js")`, `await import("./config.js")`) and `apps/proxy/src/index.ts:153`. Justified as CLI-startup latency, not circular. |
| No `rm`, use `rmtrash` | N/A (tooling rule, not code) |
| Code behind avoidance of fallback routing | Mostly followed | `session.mode` is used to route inputs at `apps/proxy/src/serve.ts:816-844`. |
| Share schemas via `packages/shared` | Followed for envelope + relay-control; **IPC protocol** (`apps/proxy/src/ipc-protocol.ts`) has its own schema not in shared — justified since IPC is local. |
| `shared` rebuild discipline | Enforced by `workspace:*` + tsup output paths — consumers import `dist/index.js` at runtime (memory `project_shared_rebuild`). |

---

*Convention analysis: 2026-04-20*
