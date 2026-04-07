---
status: partial
phase: 05-relay-server-resilience
source: [05-VERIFICATION.md]
started: 2026-04-07T10:50:00Z
updated: 2026-04-07T10:50:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. End-to-End Proxy Reconnection
expected: Start relay + proxy, kill relay, verify proxy reconnects with backoff, queue flushes, re-registers with same proxyId
result: [pending]

### 2. Client Reconnection with Replay
expected: Connect client, receive messages, disconnect, reconnect with client_register(clientId, lastSeq), receive missed messages individually with status "restored"
result: [pending]

### 3. Grace Period Behavior
expected: Disconnect proxy while client connected, client receives proxy_offline notification, reconnect proxy, client re-registers and gets "restored"
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps
