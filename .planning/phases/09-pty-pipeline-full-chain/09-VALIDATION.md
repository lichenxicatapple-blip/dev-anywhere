---
phase: 9
slug: pty-pipeline-full-chain
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-15
---

# Phase 9 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `vitest.config.ts` (per-package) |
| **Quick run command** | `pnpm test` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 09-01-01 | 01 | 1 | PTY-01 | — | N/A | unit | `pnpm --filter proxy test` | ❌ W0 | ⬜ pending |
| 09-01-02 | 01 | 1 | PTY-02 | — | N/A | unit | `pnpm --filter proxy test` | ❌ W0 | ⬜ pending |
| 09-02-01 | 02 | 2 | PTY-03 | — | N/A | unit | `pnpm --filter proxy test` | ❌ W0 | ⬜ pending |
| 09-03-01 | 03 | 2 | PTY-04 | — | N/A | unit | `pnpm --filter relay test` | ❌ W0 | ⬜ pending |
| 09-04-01 | 04 | 3 | FRONT-07 | — | N/A | e2e | `pnpm --filter web build` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] EventStore unit tests — CCAE format encode/decode, write/read, gzip archival
- [ ] Headless snapshot tests — snapshot generation and recovery
- [ ] Binary IPC frame tests — mixed protocol encode/decode
- [ ] Relay binary passthrough tests — binary frame routing
- [ ] E2E test stubs for full chain verification

*Tests will be created alongside implementation per D-38 (tests migrate with code).*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| ANSI colors render correctly | FRONT-07 | Visual quality cannot be automated | Open /pty-test, verify colored output matches local terminal |
| CJK characters display at correct width | FRONT-07 | Font rendering is visual | Type CJK text in PTY, verify no overlap in /pty-test |
| Cursor positioning is accurate | FRONT-07 | Cursor behavior is visual | Run vim or htop, verify cursor matches local terminal |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
