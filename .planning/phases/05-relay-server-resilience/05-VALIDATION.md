---
phase: 5
slug: relay-server-resilience
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-07
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^4.1.2 |
| **Config file** | `apps/relay/vitest.config.ts` |
| **Quick run command** | `pnpm --filter @cc-anywhere/relay test && pnpm --filter @cc-anywhere/proxy test` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter @cc-anywhere/relay test && pnpm --filter @cc-anywhere/proxy test`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 05-01-01 | 01 | 1 | RELAY-02 | T-05-02 | Per-session 1000-msg cap prevents buffer exhaustion | unit | `pnpm --filter @cc-anywhere/proxy test -- --grep "reconnect"` | ❌ W0 | ⬜ pending |
| 05-01-02 | 01 | 1 | RELAY-02 | — | N/A | unit | `pnpm --filter @cc-anywhere/proxy test -- --grep "MessageQueue"` | ❌ W0 | ⬜ pending |
| 05-01-03 | 01 | 1 | RELAY-02 | T-05-01 | Single timer per proxyId; reconnect cancels existing | unit | `pnpm --filter @cc-anywhere/relay test -- --grep "grace"` | ❌ W0 | ⬜ pending |
| 05-02-01 | 02 | 1 | RELAY-04 | T-05-02 | Per-session buffer with cap | unit | `pnpm --filter @cc-anywhere/relay test -- --grep "SessionBuffer"` | ❌ W0 | ⬜ pending |
| 05-02-02 | 02 | 1 | RELAY-04 | — | N/A | unit | `pnpm --filter @cc-anywhere/relay test -- --grep "compression"` | ❌ W0 | ⬜ pending |
| 05-02-03 | 02 | 2 | RELAY-04 | — | N/A | integration | `pnpm --filter @cc-anywhere/relay test -- --grep "client_register"` | ❌ W0 | ⬜ pending |
| 05-02-04 | 02 | 2 | RELAY-04 | T-05-04 | Rate-limit replay_request per client | integration | `pnpm --filter @cc-anywhere/relay test -- --grep "replay"` | ❌ W0 | ⬜ pending |
| 05-02-05 | 02 | 2 | RELAY-04 | — | N/A | integration | `pnpm --filter @cc-anywhere/relay test -- --grep "proxy_offline"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `apps/relay/src/__tests__/session-buffer.test.ts` — stubs for RELAY-04a, 04b, 04c
- [ ] `apps/relay/src/__tests__/grace-period.test.ts` — stubs for RELAY-02d
- [ ] `apps/relay/src/__tests__/client-register.test.ts` — stubs for RELAY-04d, 04e, 04g
- [ ] `apps/relay/src/__tests__/replay.test.ts` — stubs for RELAY-04f
- [ ] `apps/proxy/src/__tests__/relay-connection.test.ts` — stubs for RELAY-02a, 02b, 02e
- [ ] `packages/shared/src/schemas/__tests__/relay-control.test.ts` — UPDATE existing to cover new message types

*Existing infrastructure covers framework install (vitest already in relay devDeps).*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Feishu mini program background/foreground cycle | RELAY-04 | Requires real device and Feishu app | 1. Open mini program, connect to active session. 2. Press home button (background). 3. Wait 10s. 4. Reopen mini program. 5. Verify messages received during background period appear. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
