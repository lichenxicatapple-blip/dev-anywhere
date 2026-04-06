---
created: "2026-04-06T22:57:31.598Z"
title: 小程序消息缓存采用快照清理策略
area: feishu
files:
  - apps/proxy/src/event-store.ts
---

## Problem

飞书小程序 `tt.setStorageSync` 约 10MB 存储上限，PTY 流式消息量大，长会话容易撑满。需要一套快照清理机制控制本地缓存大小。

## Solution

复用 proxy 侧 EventStore 的快照模式：
- 收到 snapshot 事件后，清理该快照之前的所有原始消息
- Storage 只保留：最近一个快照 + 快照之后的增量消息
- 重新打开时：渲染快照 -> 追加增量 -> 带 lastSeq 连 relay 拉新消息

涉及阶段：
- Phase 6：小程序本地 storage 缓存 + 快照清理逻辑
- Phase 8：快照内容渲染（terminal state -> 移动端友好的结构化展示）
