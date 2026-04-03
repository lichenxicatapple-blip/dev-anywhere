---
created: 2026-04-03T13:05:27.089Z
title: 审视 vitest config 是否需要每个包单独配置
area: tooling
files:
  - vitest.config.ts
  - packages/shared/vitest.config.ts
  - apps/proxy/vitest.config.ts
---

## Problem

当前每个子包（shared, proxy）都有自己的 vitest.config.ts，根目录也有一个使用 projects 模式聚合的 vitest.config.ts。随着 relay 和 feishu 包加入，会有 5-6 个 vitest config 文件。

需要评估是否可以简化：
1. 当前方式是 vitest workspace 的标准做法，`--project` 过滤依赖每个子包有独立配置
2. 如果所有包的测试配置都一样（只是 include 路径不同），可能可以在根配置中统一定义
3. 但如果某些包需要特殊配置（如 mock 设置、环境变量），独立配置更灵活

## Solution

检查 vitest 文档中 workspace 模式的最佳实践，评估是否可以用根 vitest.workspace.ts 统一管理，减少配置文件数量。低优先级，当前方案可正常工作。
