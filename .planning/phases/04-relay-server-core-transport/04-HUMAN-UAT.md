---
status: partial
phase: 04-relay-server-core-transport
source: [04-VERIFICATION.md]
started: 2026-04-06T16:40:00Z
updated: 2026-04-06T16:40:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. End-to-end relay connectivity
expected: Start relay (pnpm --filter @cc-anywhere/relay dev), proxy with RELAY_URL=ws://localhost:3100 (pnpm --filter @cc-anywhere/proxy dev -- serve), and wscat client (npx wscat -c ws://localhost:3100/client). Send proxy_list_request, receive proxy in list, select proxy, verify bidirectional message routing.
result: [pending]

### 2. Taro Feishu/Lark spike in developer tools
expected: Build for Lark (pnpm --filter @cc-anywhere/feishu build:lark), open in Feishu IDE simulator, connect to echo server, send JSON, receive echo back.
result: [pending]

### 3. Docker build verification
expected: Run docker build -f apps/relay/Dockerfile -t cc-anywhere-relay . from repo root. Build completes without errors.
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps
