# Phase 8: Business Logic Adaptation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-16
**Phase:** 08-business-logic-adaptation
**Areas discussed:** 状态管理, 路由设计, WebSocket 管理, PhaseNav 抽象, 重连策略, pty-test 改造, 文件结构, 状态流转, 验证方式, 冷启动恢复, use-screen-size 归属, 服务层迁移, app.tsx 接线, 占位页面, relay URL 配置, Toast, localStorage keys, 路由保护, Store 持久化, 状态机归属, 前后台切换

---

## 状态管理

| Option | Description | Selected |
|--------|-------------|----------|
| zustand | 轻量状态管理库，代码更简洁，不需要 Provider 嵌套 | ✓ |
| Context + useReducer 原样搬 | 直接复制 Feishu 的 reducer，只替换 Taro API | |

**User's choice:** zustand
**Notes:** 用户不熟悉 store/reducer 概念，解释后选择了 zustand

---

## 路由设计

| Option | Description | Selected |
|--------|-------------|----------|
| 简洁路径 | /#/, /#/sessions, /#/chat/:id | ✓ |
| Feishu 风格路径 | /#/pages/proxy-select/index 等 | |

**User's choice:** 简洁路径
**Notes:** None

---

## WebSocket 管理

| Option | Description | Selected |
|--------|-------------|----------|
| 统一管理器 | 单一连接处理 text + binary，按数据类型分发 | ✓ |
| 分开管理 | JSON 和 binary 各用独立 WebSocket 连接 | |

**User's choice:** 统一管理器
**Notes:** None

---

## PhaseNav 抽象

| Option | Description | Selected |
|--------|-------------|----------|
| 溶解到 zustand + react-router | 取消接口，直接用原生 API | ✓ |
| 保留 PhaseNav 接口 | 换成浏览器实现但保持接口 | |

**User's choice:** 溶解
**Notes:** 用户不熟悉 PhaseNav 概念，解释后选择溶解

---

## 重连策略

| Option | Description | Selected |
|--------|-------------|----------|
| 指数退避 | 1s→2s→4s→8s→30s 封顶，前台时立即重连 | ✓ |
| 固定 2 秒 | 与 Feishu 版一致 | |

**User's choice:** 指数退避
**Notes:** None

---

## pty-test 改造

| Option | Description | Selected |
|--------|-------------|----------|
| 改造为使用统一管理器 | 验证 binary 分发逻辑 | ✓ |
| 保留独立 WebSocket | 调试工具不依赖业务逻辑 | |

**User's choice:** 改造
**Notes:** None

---

## 文件结构

| Option | Description | Selected |
|--------|-------------|----------|
| 按职责分层 | stores/ + services/ + hooks/ + pages/ + components/ | ✓ |
| Feishu 原样结构 | 完全复制目录结构 | |

**User's choice:** 按职责分层
**Notes:** None

---

## 状态流转

| Option | Description | Selected |
|--------|-------------|----------|
| 保留原状态流 | connecting→registering→proxy_selecting→session_browsing→chatting | ✓ |
| 简化状态机 | 合并状态，减少数量 | |

**User's choice:** 保留原状态流
**Notes:** None

---

## 验证方式

| Option | Description | Selected |
|--------|-------------|----------|
| 单元测试 + 手动联调 | vitest 单测 + 真实 relay/proxy 联调 | ✓ |
| 只要 typecheck 通过 | 运行时验证留给 Phase 10 | |

**User's choice:** 单元测试 + 手动联调
**Notes:** None

---

## 冷启动恢复

| Option | Description | Selected |
|--------|-------------|----------|
| 保留 | 自动恢复之前的 proxy 和会话 | ✓ |
| 去掉 | 每次从 proxy 选择页开始 | |

**User's choice:** 保留
**Notes:** None

---

## use-screen-size 归属

**User's choice:** 不迁移到 Phase 8
**Notes:** 用户认同浏览器有更好的原生 CSS 方案（dvh、env(safe-area-inset-*)），不需要保持 Feishu 版的 JS 实现。Phase 10 按需用 CSS 替代

---

## 服务层迁移

| Option | Description | Selected |
|--------|-------------|----------|
| 直接复制 | relay-client.ts 等无 Taro 依赖文件直接复制 | ✓ |
| 借机重构 | 重写代码结构 | |

**User's choice:** 直接复制
**Notes:** 用户明确不做无明确收益的重构。纯净 stores 复制后改写为 zustand

---

## app.tsx 接线

| Option | Description | Selected |
|--------|-------------|----------|
| 完整接线 | react-router + WebSocket + 状态机 + 冷启动 + 占位页 | ✓ |
| 只做 store/service | 不改 app.tsx，留给 Phase 10 | |

**User's choice:** 完整接线
**Notes:** None

---

## 占位页面

| Option | Description | Selected |
|--------|-------------|----------|
| 调试信息面板 | 显示路由名、状态、连接状态、proxy、session | ✓ |
| 最简占位符 | 只显示页面名称 | |

**User's choice:** 调试信息面板
**Notes:** None

---

## relay URL 配置

| Option | Description | Selected |
|--------|-------------|----------|
| 环境变量 + localStorage | 三级优先级：localStorage > env > 同源 | ✓ |
| 只用同源 | 依赖 Phase 12 同源部署 | |

**User's choice:** 环境变量 + localStorage
**Notes:** None

---

## Toast

| Option | Description | Selected |
|--------|-------------|----------|
| 简单实现 | zustand store + 全局 Toast 组件 | ✓ |
| console.log 替代 | 不做视觉展示 | |

**User's choice:** 简单实现
**Notes:** Phase 10 换成 shadcn/ui toast

---

## localStorage keys

| Option | Description | Selected |
|--------|-------------|----------|
| 保持一致 | cc_clientId, cc_proxyId 等不变 | ✓ |
| 重新命名 | 用 ccaw. 前缀 | |

**User's choice:** 保持一致
**Notes:** None

---

## 路由保护

| Option | Description | Selected |
|--------|-------------|----------|
| 保留 | 状态不对时自动重定向 | ✓ |
| 留给 Phase 10 | 占位页不需要保护 | |

**User's choice:** 保留
**Notes:** None

---

## Store 持久化

**User's choice:** 手动存取（Claude's Discretion）
**Notes:** 用户不熟悉 zustand persist 概念，解释后确认沿用 Feishu 版的手动存取模式

---

## 状态机归属

| Option | Description | Selected |
|--------|-------------|----------|
| 保持独立文件 | services/phase-machine.ts，直接 import app-store | ✓ |
| 融入 app-store | 合并为一个 ~300 行的 zustand store | |

**User's choice:** 保持独立文件
**Notes:** 用户不清楚 phase-machine 是否还独立存在，解释两种方案的区别后选择独立

---

## 前后台切换

| Option | Description | Selected |
|--------|-------------|----------|
| 检测 + 重连 | visibilitychange 事件触发 WebSocket 状态检测和重连 | ✓ |
| 不特殊处理 | 依赖现有重连逻辑 | |

**User's choice:** 检测 + 重连
**Notes:** 已包含在指数退避策略中

---

## Claude's Discretion

- zustand middleware 选择
- 占位页面具体布局
- 单元测试覆盖范围和 mock 策略
- binary 帧订阅/分发 API 设计
- import 路径别名配置（@/ 指向 src/）
- 改动范围仅限 apps/web（不改 relay/proxy）

## Deferred Ideas

None — discussion stayed within phase scope
