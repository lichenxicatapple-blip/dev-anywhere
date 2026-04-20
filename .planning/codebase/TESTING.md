# Testing Patterns

**Analysis Date:** 2026-04-20

## Test Framework

**Runner:** Vitest `^4.1.2` (devDependency at root; each workspace also lists it). `@vitest/coverage-v8 ^4.1.4` available at root.

**Assertion library:** Built-in `expect` from vitest. Web tests also use `@testing-library/jest-dom ^6.9.1` (installed, not imported — there is **no setupFiles** wiring `jest-dom`; tests rely on raw vitest `expect` + `@testing-library/react` queries).

**Root config (`vitest.config.ts`):**
```typescript
export default defineConfig({
  test: { projects: ["packages/*", "apps/*"] },
});
```
Uses Vitest workspace "projects" API so a single `pnpm test` run fans out to per-package configs.

**Per-workspace configs:**
- `packages/shared/vitest.config.ts` — `name: "shared"`, include `src/**/*.test.ts`, `integration` scope yields empty include (shared has only unit tests).
- `apps/proxy/vitest.config.ts` — `name: "proxy"`, aliases `@lichenxi.cat/cc-anywhere-relay/server` → `apps/relay/src/server.ts` (source), supports `TEST_SCOPE=unit|integration`.
- `apps/relay/vitest.config.ts` — `name: "relay"`, aliases `@cc-anywhere/shared` → `packages/shared/src/index.ts`, supports `TEST_SCOPE`.
- `apps/web/vitest.config.ts` — `name: "web"`, `environment: "jsdom"`, aliases `@` → `./src` and `@cc-anywhere/shared` → source; supports `.test.tsx`.

**E2E (web only):** Playwright `^1.52.0`, config at `apps/web/playwright.config.ts`:
- `testDir: "./e2e"`, `timeout: 30000`
- Two projects: `mobile` (390x844, hasTouch) and `desktop` (1280x800)
- **No `webServer`** — dev server must be started manually via `pnpm --filter web dev` (per comment in config).

## Run Commands

**Root:**
```bash
pnpm test                    # vitest run — runs all workspaces
pnpm test:unit               # TEST_SCOPE=unit vitest run
pnpm test:integration        # TEST_SCOPE=integration vitest run
```

**Per workspace:**
```bash
pnpm --filter @cc-anywhere/shared test
pnpm --filter @lichenxi.cat/cc-anywhere test
pnpm --filter @lichenxi.cat/cc-anywhere-relay test
pnpm --filter @cc-anywhere/web test
pnpm --filter @cc-anywhere/web test:e2e
```

**Coverage:** `@vitest/coverage-v8` is installed but **no coverage config, no `test:coverage` script, no enforced thresholds**. No `coverage/` directory in repo. ESLint `ignores` lists `coverage/**` speculatively.

## Test File Organization

**Backend (`apps/proxy`, `apps/relay`, `packages/shared`):** tests live under `src/__tests__/` split into `unit/` and `integration/`.
- `apps/proxy/src/__tests__/unit/` — 14 files including `session-manager.test.ts`, `pty-manager.test.ts`, `json-session.test.ts`, `ipc-protocol.test.ts`, `osc-extractor.test.ts`, `line-buffer.test.ts`, `command-discovery.test.ts`, `control-messages.test.ts`, `tool-approval.test.ts`, `file-watcher.test.ts`, `remote-input-raw.test.ts`, `session-history.test.ts`, `terminal-data-flow.test.ts`, `relay-connection-state.test.ts`.
- `apps/proxy/src/__tests__/integration/relay-connection.test.ts` — single integration file; spins a real `createRelayServer` in `beforeAll`.
- `apps/proxy/src/__tests__/fixtures/pty-recording.bin` — binary PTY capture for replay-style tests.
- `apps/relay/src/__tests__/unit/` — `registry.test.ts`, `router.test.ts`, `proxy-to-client-types.test.ts`.
- `apps/relay/src/__tests__/integration/` — `server.test.ts`, `client-register.test.ts`, `message-routing.test.ts`, `proxy-auth.test.ts`, `relay-resilience.test.ts`, `replay.test.ts`.
- `apps/relay/src/__tests__/helpers.ts` — shared test utilities (`waitForOpen`, `waitForMessage`, `waitForMessageType`, `collectMessages`, `getPort`, `settle`, `makeEnvelope`).
- `packages/shared/src/schemas/__tests__/` — `envelope.test.ts`, `chat.test.ts`, `tool.test.ts`, `session.test.ts`, `system.test.ts`, `relay-control.test.ts`.
- `packages/shared/src/builders/__tests__/builders.test.ts`.

**Web (`apps/web`):** **divergent** — tests are **co-located** next to source (not under `__tests__/`):
- `apps/web/src/components/chat/message-bubble.test.tsx`
- `apps/web/src/components/chat/markdown-view.test.tsx`
- `apps/web/src/stores/chat-store.test.ts`
- `apps/web/src/lib/ansi-keys.test.ts`

One exception: `apps/web/src/__tests__/unit/theme-tokens.test.ts` (only file under `__tests__/unit/`). The vitest config's include glob covers both patterns (`src/**/*.test.{ts,tsx}`).

**E2E (`apps/web/e2e/`):** Playwright `*.spec.ts` files with shared `helpers.ts`:
- `smoke.spec.ts`, `chat-chrome.spec.ts`, `file-picker.spec.ts`, `follow-output.spec.ts`, `input-bar.spec.ts`, `master-detail.spec.ts`, `proxy-switcher.spec.ts`, `session-list.spec.ts`, `shell.spec.ts`, `toast.spec.ts`, `tool-approval.spec.ts` (11 files, 716 lines total).
- `test-hooks.d.ts` — type declarations for `window.__ccTest` hooks exposed by `apps/web/src/test-hooks.ts` (only active in `import.meta.env.DEV`).

## Test Structure

**Unit test template:**
```typescript
// apps/proxy/src/__tests__/unit/session-manager.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionManager } from "#src/session-manager.js";
import { SessionState } from "@cc-anywhere/shared";

describe("SessionManager", () => {
  let manager: SessionManager;
  beforeEach(() => {
    persistPath = join(makeTmpDir(), "sessions.json");
    manager = new SessionManager({ persistPath });
  });
  afterEach(() => { manager.stopReaper(); });

  describe("updateState", () => {
    it("transitions idle -> working", () => {
      const s = manager.createSession("pty", "/tmp/test", ALIVE_PID);
      manager.updateState(s.id, SessionState.WORKING);
      expect(manager.getSession(s.id)!.state).toBe(SessionState.WORKING);
    });
  });
});
```

Nested `describe` per method / scenario is the norm. `it("<sentence>")` descriptions in English, imperative voice.

**Integration test template:**
```typescript
// apps/relay/src/__tests__/integration/message-routing.test.ts
beforeEach(async () => {
  relay = createRelayServer({ port: 0, heartbeatInterval: 60000, logger });
  await new Promise<void>((resolve) => { relay.httpServer.listen(0, resolve); });
  port = getPort(relay);
});
afterEach(async () => {
  for (const ws of connections) ws.close();
  connections.length = 0;
  await relay.close();
});
```
Port `0` for ephemeral ports; connections tracked in a local array and torn down. Real `createRelayServer` instance, no mocks. Shared helpers from `apps/relay/src/__tests__/helpers.ts`.

**Setup/teardown:** `beforeEach` / `afterEach` only. `beforeAll` / `afterAll` reserved for expensive server startup in `apps/proxy/src/__tests__/integration/relay-connection.test.ts`. No global `setupFiles`.

**Silent logger in tests:**
```typescript
const logger = createLogger({ name: "test", silent: true });
```
Used in every relay integration suite. Proxy auto-silences via `VITEST` env check in `apps/proxy/src/logger.ts`.

## Mocking Patterns

**No mocking library beyond vitest's built-in `vi`.** `jest.fn` / `sinon` not used.

**Module mocks via `vi.mock`** (hoisted):
```typescript
// apps/proxy/src/__tests__/unit/pty-manager.test.ts:20
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    mockPty = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: vi.fn(...), onExit: vi.fn(...), pid: 12345 };
    return mockPty;
  }),
}));
```
Callback refs captured at module level (`onDataCallback`, `onExitCallback`) so tests can trigger the real handler paths.

**Child process mocks:**
```typescript
// apps/proxy/src/__tests__/unit/tool-approval.test.ts:49
vi.mock("node:child_process", () => ({ spawn: vi.fn(() => mockChild) }));
```
Built on `EventEmitter` + `PassThrough` streams to simulate stdout/stderr/stdin I/O.

**Per-test mock factories:**
```typescript
// apps/relay/src/__tests__/unit/router.test.ts:7
function createMockWs(overrides: Record<string, unknown> = {}): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(), close: vi.fn(), terminate: vi.fn(),
    ...overrides,
  } as unknown as WebSocket;
}

function createMockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() } as unknown as Logger;
}
```

**Clear-between-tests:** `beforeEach(() => { vi.clearAllMocks(); onDataCallback = null; ... })` in suites with module-level state.

**What is NOT mocked in integration tests:**
- Real `createRelayServer` spun on `port: 0`.
- Real `ws` WebSocket clients connecting over loopback.
- Real file system (temp dirs via `mkdtempSync(join(tmpdir(), "prefix-"))`).
- Real zod parsing through shared schemas.

Per memory `feedback_test_production_path` this is intentional: tests hit production wiring, only substituting the data source or transport endpoint.

## Fixtures & Factories

**Binary fixture:** `apps/proxy/src/__tests__/fixtures/pty-recording.bin` (captured PTY output for replay). Conversion helper at `apps/web/scripts/convert-fixture.ts`.

**Message factory (shared test util):**
```typescript
// apps/relay/src/__tests__/helpers.ts:100
export function makeEnvelope(seq, sessionId = "s1", type = "assistant_message", source = "proxy") {
  return { seq, sessionId, timestamp: Date.now(), source, version: "1.0", type, payload: ... };
}
```

**Test-local factories** (inlined per test file to avoid over-generalization — see memory `feedback_test_quality_principles` banning copy-paste helpers):
```typescript
// apps/web/src/components/chat/message-bubble.test.tsx:9
function makeMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return { id: "m-1", role: "user", text: "hello", isPartial: false, timestamp: 0, toolCalls: [], ...overrides };
}
```

**Temp directories:** `mkdtempSync(join(tmpdir(), "session-mgr-test-"))` — each test gets isolated FS state. No cleanup (relies on OS temp reaper).

**Fixed "alive" PID:** tests use `process.pid` for "this process is alive" and `999999` for "dead PID" — works because kill(pid, 0) tests OS-level process existence.

## Test Types

### Unit Tests

**Proxy (`apps/proxy/src/__tests__/unit/`):** 14 files, ~90 `describe` blocks covering:
- `SessionManager` state transitions and persistence.
- `PtyManager` pty lifecycle (mocked `node-pty`).
- `JsonSession` / `ToolWhitelist` with mocked `spawn`.
- `LineBuffer` Transform stream behavior.
- OSC extractor regex logic.
- IPC protocol serialize/deserialize round-trips.
- Control-message handlers (`dir_list`, `dir_create`, file tree, session history).
- `RelayConnectionState` transitions (no network).
- Remote raw input routing through the PTY path.

**Relay (`apps/relay/src/__tests__/unit/`):** 3 files — `registry.test.ts` (13 describes), `router.test.ts` (3 describes, parser + proxy/client routing), `proxy-to-client-types.test.ts` (allowlist integrity).

**Shared (`packages/shared/src/schemas/__tests__/`):** 6 files — one per schema file. Tests validate required fields, enum constraints, missing-field rejection, and discriminated-union resolution.

**Web:** 5 test files (4 co-located, 1 in `__tests__/unit/`).
- `chat-store.test.ts` — zustand slice isolation per sessionId, turn-complete behavior, approval status.
- `message-bubble.test.tsx` — React Testing Library; `afterEach(cleanup)` required because vitest does not auto-cleanup (see comment at line 6).
- `markdown-view.test.tsx` — XSS protection via `skipHtml` / rehype config.
- `ansi-keys.test.ts` — keyboard event → ANSI escape mapping.
- `theme-tokens.test.ts` — **questionable pattern**: reads `app.css`, `button.tsx`, `sonner.tsx` as raw strings and asserts on `toMatch(/--primary:\s*#D4A574;/)`. This is source-code grep as test, which per memory `feedback_test_quality_principles` is a banned anti-pattern. It will flag legitimate refactors (e.g., extracting tokens to a separate file) as failures.

### Integration Tests

**Relay (6 files):** each spins a real `createRelayServer` on `port: 0` and drives it with real `ws.WebSocket` clients over loopback.
- `server.test.ts` — basic lifecycle, heartbeat.
- `client-register.test.ts` — 3-state register (`new`, `restored`, `proxy_offline`).
- `message-routing.test.ts` — envelope and control forwarding both directions.
- `proxy-auth.test.ts` — token gating on `/proxy` endpoint.
- `relay-resilience.test.ts` — proxy disconnect / reconnect / offline grace.
- `replay.test.ts` — `replay_request` always yields `gap_unrecoverable` (relay stateless).

**Proxy (1 file):** `relay-connection.test.ts` — instantiates real `RelayConnection` + real relay server, asserts register/send/reconnect/flush-queue behavior. Depends on the cross-package alias `@lichenxi.cat/cc-anywhere-relay/server` pointing at relay source.

### E2E Tests (web only)

11 Playwright specs covering user-visible flows: boot smoke, chat chrome, input bar, file picker, session list, follow output, master-detail routing, proxy switcher, shell, toast, tool approval.

**Test runner coordination:** dev server must be up (`pnpm --filter web dev`) — no auto-start in config. `apps/web/src/test-hooks.ts` exposes `window.__ccTest` + `window.__APP_STORE__` / `window.__SESSION_STORE__` in dev mode only; E2E tests `page.evaluate()` to manipulate stores directly instead of fully booting relay+proxy+claude:
```typescript
// apps/web/e2e/master-detail.spec.ts:22
await page.evaluate(() => {
  window.__SESSION_STORE__?.getState().addSession({ sessionId: "test-sess-1", ... });
});
```

Tests that require backend infrastructure that's not mocked (`__SESSION_STORE__` not yet exposed) use `test.skip(true, "...")` with a comment pointing at the blocking phase.

**Viewports:** `mobile` project (390x844, hasTouch) and `desktop` project (1280x800) — most specs run under both unless `test.use({ viewport: ... })` overrides.

## Coverage

- `@vitest/coverage-v8` installed at root, never invoked.
- No coverage threshold config.
- No CI enforcement visible in repo.
- Running `pnpm vitest run --coverage` would work out of the box but produces no baseline the team tracks.

## Common Patterns

### Async / timing in tests

Ad-hoc sleeps appear frequently:
```typescript
// apps/proxy/src/__tests__/integration/relay-connection.test.ts:51
await new Promise((resolve) => setTimeout(resolve, 300));

// apps/relay/src/__tests__/helpers.ts:95
export const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));
```
`waitForRegistration` (`apps/proxy/src/__tests__/integration/relay-connection.test.ts:13`) is a thin `setTimeout(100)` wrapper with a misleading name — **not** event-driven. Suite flakiness risk under load, though timeouts (100-300ms) have headroom on a quiet machine. Prefer `waitForMessageType` / event promises where possible.

### Error testing

```typescript
expect(() => manager.updateState(s.id, SessionState.IDLE)).toThrow();
// or
expect(() => MessageEnvelopeSchema.parse(bad)).toThrow();
```
String-matched error messages are rare; tests usually just assert `toThrow()` without a matcher.

### WebSocket / message assertions

```typescript
// apps/relay/src/__tests__/integration/message-routing.test.ts:81
const received = JSON.parse(await msgPromise);
expect(received.type).toBe("assistant_message");
expect(received.payload.text).toBe("hello");
```
No schema re-validation in tests — the shape is asserted field-by-field. This drifts from the production path, which always parses through zod.

### React component tests

```typescript
// apps/web/src/components/chat/message-bubble.test.tsx
import { cleanup, render, screen } from "@testing-library/react";
afterEach(cleanup);  // vitest 不自动 cleanup
render(<MessageBubble message={makeMessage({ ... })} sessionId="s1" />);
const bubble = screen.getByRole("article");
expect(bubble.getAttribute("data-role")).toBe("user");
```
`afterEach(cleanup)` is manual because no global setup file wires it. No shared render helper.

### E2E locator style

`data-slot="..."` data attributes used as stable hooks — decoupled from classnames. `role="article"` and `aria-label` for semantic queries.

## Divergence Between Workspaces

| Aspect | apps/proxy | apps/relay | apps/web | packages/shared |
|--------|------------|------------|----------|-----------------|
| Test folder | `src/__tests__/{unit,integration}/` | `src/__tests__/{unit,integration}/` | **co-located** `*.test.tsx` next to source + one `src/__tests__/unit/` file | `src/*/__tests__/` next to source dir |
| Environment | node (default) | node | `jsdom` | node |
| Integration tests | 1 file | 6 files | Playwright E2E instead | none |
| Path alias | `#src/*` (only in tests) | `#src/*` (only in tests) | `@/*` (src and tests) | relative only |
| Cross-package alias | `@lichenxi.cat/cc-anywhere-relay/server` → relay src | `@cc-anywhere/shared` → shared src | `@cc-anywhere/shared` → shared src | n/a |
| Logger silencing | Env-driven (`process.env.VITEST`) | Explicit `silent: true` per test | N/A (no pino) | N/A |
| Shared helpers | None beyond mock factories | `__tests__/helpers.ts` | `e2e/helpers.ts` + `test-hooks.ts` | None |

## Tested vs Not Tested

**Well covered:**
- Shared schemas (every payload/envelope variant has a dedicated file).
- `SessionManager` state machine (full transition matrix).
- `RelayRegistry` state transitions, binding, cleanup.
- Router parse + routing for both control and envelope messages.
- `RelayConnection` network behavior via real relay.
- zustand `chat-store` per-session slicing.
- XSS protection in markdown renderer.

**Under-covered / gaps:**
- `apps/proxy/src/serve.ts` (1183 LOC) — the central relay-message dispatch `if/else if` chain has no direct unit test; behavior tested indirectly via `relay-connection.test.ts` integration. The `handleTerminalConnection` IPC handler switch is similarly untested.
- `apps/proxy/src/terminal.ts` (321 LOC) — no dedicated test. Only `terminal-data-flow.test.ts` covers the data forwarding piece.
- `apps/proxy/src/session-worker.ts` — worker entry point untested beyond spawn wiring.
- `apps/relay/src/handlers/proxy.ts` — integration-tested only; `PROXY_TO_CLIENT_TYPES` allowlist has a dedicated unit test but the handler's binary-frame path is not covered by unit tests.
- Web services (`relay-client.ts`, `websocket.ts`, `chat-dispatcher.ts`, `session-dispatcher.ts`, `resource-dispatcher.ts`, `phase-machine.ts`, `ensure-binding.ts`) — **no unit tests**. Some coverage via E2E.
- Web hooks (`use-relay-setup`, `use-follow-output`, `use-visual-viewport`, `use-sidebar-collapsed`, `use-keyboard-shortcut`, `use-media-query`) — no tests.
- Web pages (`chat.tsx`, `proxy-select.tsx`, `session-list.tsx`, `pty-test.tsx`) — only E2E.
- PWA / service worker generation — not tested.
- Deploy scripts (`apps/relay/deploy.sh`, `apps/relay/scripts/verify-relay.ts`) — `verify-relay.ts` is itself a manual verification script, not a test.

---

*Testing analysis: 2026-04-20*
