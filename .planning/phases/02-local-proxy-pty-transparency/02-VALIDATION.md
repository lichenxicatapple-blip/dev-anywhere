---
phase: 02
slug: local-proxy-pty-transparency
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-03
---

# Phase 02 -- Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.x |
| **Config file** | vitest.config.ts (root projects config) |
| **Quick run command** | `pnpm vitest run --project proxy` |
| **Full suite command** | `pnpm vitest run` |
| **Estimated runtime** | ~2 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm vitest run --project proxy`
- **After every plan wave:** Run `pnpm vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 1 | PROXY-01 | unit | `pnpm vitest run --project proxy` | W0 | pending |
| 02-01-02 | 01 | 1 | PROXY-01 | unit | `pnpm vitest run --project proxy` | W0 | pending |
| 02-02-01 | 02 | 2 | PROXY-01 | integration | `pnpm vitest run --project proxy` | W0 | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [ ] `apps/proxy/vitest.config.ts` -- proxy-specific vitest config
- [ ] `apps/proxy/src/__tests__/` -- test directory structure
- [ ] `node-pty` -- native module dependency installed

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| ANSI colors render correctly | PROXY-01 SC-1 | Requires visual terminal inspection | Run cc-anywhere, verify colors match direct claude run |
| Terminal resize propagates | PROXY-01 SC-2 | Requires physical window resize | Resize terminal during active session, verify output reflows |
| Ctrl+C interrupts correctly | PROXY-01 SC-3 | Requires interactive terminal | Press Ctrl+C during tool execution, verify it cancels |
| No orphan processes on exit | PROXY-01 SC-4 | Requires process inspection | Exit cc-anywhere, run `ps aux | grep claude` |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
