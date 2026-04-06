---
phase: 04
slug: relay-server-core-transport
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-04-06
---

# Phase 04 -- Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 2.x |
| **Config file** | apps/relay/vitest.config.ts, apps/feishu/vitest.config.ts |
| **Quick run command** | `pnpm --filter @cc-anywhere/relay test` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter @cc-anywhere/relay test`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 04-01-01 | 01 | 1 | -- | T-04-01 | N/A | integration | `pnpm --filter @cc-anywhere/feishu test` | W0 | pending |
| 04-01-02 | 01 | 1 | -- | -- | N/A | manual | N/A (checkpoint:human-verify, Feishu IDE simulator) | -- | pending |
| 04-02-01 | 02 | 1 | RELAY-01 | T-04-05 | zod validation of relay control messages | unit | `pnpm --filter @cc-anywhere/shared test && pnpm --filter @cc-anywhere/relay test` | W0 | pending |
| 04-02-02 | 02 | 1 | RELAY-01, RELAY-03 | T-04-05, T-04-06, T-04-07 | Message validation, metadata-only logging, heartbeat cleanup | unit + integration | `pnpm --filter @cc-anywhere/relay test` | W0 | pending |
| 04-02-03 | 02 | 1 | RELAY-01 | -- | N/A | build | `pnpm --filter @cc-anywhere/relay build && pnpm test` | existing | pending |
| 04-03-01 | 03 | 2 | RELAY-01, RELAY-03 | T-04-13 | N/A (no auth per D-04) | unit | `pnpm --filter @cc-anywhere/proxy test` | W0 | pending |
| 04-03-02 | 03 | 2 | RELAY-01 | T-04-10, T-04-11, T-04-12 | TLS config, Docker healthcheck, .dockerignore | build | `cd /Users/admin/workspace/cc_anywhere && test -f apps/relay/Dockerfile && test -f apps/relay/docker-compose.yml && test -f apps/relay/nginx.conf && test -x apps/relay/deploy.sh && docker build -f apps/relay/Dockerfile -t cc-anywhere-relay-test . --quiet 2>&1 \| tail -1` | -- | pending |
| 04-03-03 | 03 | 2 | RELAY-01 | -- | N/A | manual | N/A (checkpoint:human-verify, end-to-end relay connectivity) | -- | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [ ] `apps/relay/vitest.config.ts` -- vitest config for relay package
- [ ] `apps/relay/src/__tests__/` -- test directory structure
- [ ] `apps/feishu/vitest.config.ts` -- vitest config for feishu package (created in Plan 01 Task 1)
- [ ] `packages/shared/src/schemas/__tests__/relay-control.test.ts` -- relay control schema tests (created in Plan 02 Task 1)

*Existing infrastructure (vitest workspace) covers framework installation.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Taro spike connects to ws server on Feishu simulator | -- | Requires Feishu IDE/simulator | Build and run Taro project in Feishu developer tools, verify WebSocket connection |
| Docker deployment to CentOS server | -- | Requires SSH access to cloud server | Run deploy.sh, verify relay accessible via WSS |
| End-to-end relay connectivity (proxy + relay + client) | RELAY-01 | Requires 3 concurrent processes | Start relay, proxy with RELAY_URL, wscat client; verify proxy_list and message routing |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 10s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
