# Phase 8: Business Logic Adaptation - Context

**Gathered:** 2026-04-16
**Status:** Ready for planning

<domain>
## Phase Boundary

将 Feishu 小程序的非 UI 业务逻辑（状态机、stores、services、WebSocket 层）迁移到 apps/web，使用浏览器原生 API（react-router、localStorage、WebSocket）替换所有 Taro 依赖。完成后 app.tsx 接线完毕，占位页面可验证全链路业务逻辑。

不包含：真实 UI 页面和组件（Phase 10）、use-screen-size 等纯 UI hook（Phase 10 用 CSS 原生方案替代）、PTY 链路改造（Phase 9 已完成）、断线恢复协议（Phase 11）。

改动范围仅限 apps/web，不修改 relay 或 proxy 代码。

</domain>

<decisions>
## Implementation Decisions

### 状态管理
- **D-01:** 使用 zustand 替代 Context + useReducer。所有 store 统一用 zustand 重写
- **D-02:** 纯净 stores（chat-store、session-store、command-store、file-store）从 Feishu 版复制后改写为 zustand，逻辑不变只换外壳
- **D-03:** 只在特定时机手动读写 localStorage（选 proxy 时存 proxyId，切 session 时存 sessionId），不自动同步整个 store

### 路由设计
- **D-04:** react-router v7 hash 模式，简洁路径：`/#/`（ProxySelect）、`/#/sessions`（SessionList）、`/#/chat/:id`（Chat，`?mode=pty` 参数）、`/#/pty-test`、`/#/tokens`
- **D-05:** 路由保护保留：状态机驱动路由，访问不合法状态的页面时自动重定向

### WebSocket 管理
- **D-06:** 统一 WebSocket 管理器，单一连接同时处理 text（JSON 控制消息）和 binary（PTY 数据）。按 `event.data` 类型分发：string → JSON 解析 → relay-client，ArrayBuffer → 按 sessionId 前缀路由 → xterm.js
- **D-07:** Phase 9 的 /pty-test 页面改造为使用统一管理器，作为验证 binary 分发逻辑的第一个用户
- **D-08:** 重连策略改为指数退避：1s → 2s → 4s → 8s → 30s 封顶。页面从后台回到前台时（visibilitychange 事件）立即检测并重连

### 状态机
- **D-09:** PhaseNav 接口溶解，phase-machine 直接 import app-store 读写状态、直接调 react-router navigate() 跳转、直接用 localStorage 持久化
- **D-10:** phase-machine.ts 保持独立文件，放在 services/ 下。不融入 app-store，避免单文件过大
- **D-11:** 状态流转保留原样：connecting → registering → proxy_selecting → session_browsing → chatting，外加 reconnecting 状态
- **D-12:** 冷启动恢复保留：应用打开时自动从 localStorage 读取之前的 proxyId、sessionId，尝试恢复到上次的页面

### 服务层迁移
- **D-13:** relay-client.ts、ensure-binding.ts 等无 Taro 依赖的服务文件直接复制到 apps/web/src/services/，不做重构
- **D-14:** websocket.ts 重写：去掉 Taro.connectSocket 分支和 TaskLike 抽象，直接用原生 WebSocket，加入 binary 帧处理和指数退避重连

### app.tsx 接线
- **D-15:** Phase 8 完成后 app.tsx 完整接线：react-router 配置、WebSocket 连接 relay、状态机启动、冷启动恢复流程
- **D-16:** 页面用调试信息占位符：显示当前路由名、状态机状态、WebSocket 连接状态、已选 proxy、当前 session 等。Phase 10 替换为真实 UI

### Toast
- **D-17:** 简易 toast 实现（zustand store + 全局 Toast 组件），确保状态机的 showToast 调用有地方落。Phase 10 换成 shadcn/ui toast

### 配置
- **D-18:** relay URL 优先级：localStorage('cc_relayUrl') > import.meta.env.VITE_RELAY_URL > window.location.origin
- **D-19:** localStorage key 名称保持与 Feishu 版一致：cc_clientId、cc_proxyId、cc_sessionId、cc_sessionMode、cc_relayUrl、cc_fontSizeIndex

### 文件结构
- **D-20:** 按职责分层：stores/（zustand 数据仓库）、services/（无 React 依赖的纯逻辑）、hooks/（React hooks）、pages/（页面组件）、components/（UI 组件）
- **D-21:** import 路径使用 @/ 别名指向 src/，与 Feishu 版一致

### 验证
- **D-22:** 单元测试 + 手动联调。vitest 对各 store、WebSocket 管理器、状态机写单元测试，连接真实 relay + proxy 手动验证全链路。E2E 测试留给 Phase 10

### Claude's Discretion
- zustand middleware 选择（devtools 等）
- 占位页面的具体调试信息布局
- 单元测试的具体覆盖范围和 mock 策略
- binary 帧 sessionId 订阅/分发的具体 API 设计

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Feishu 源码（迁移来源）
- `apps/feishu/src/phase-machine.ts` — 状态机核心逻辑，PhaseNav 接口定义，handleWsStatusChange/handleRelayMessage
- `apps/feishu/src/services/websocket.ts` — WebSocketManager，含 Taro 分支和原生 WebSocket 分支
- `apps/feishu/src/services/relay-client.ts` — 协议层，无 Taro 依赖，直接复制
- `apps/feishu/src/services/ensure-binding.ts` — proxy 绑定逻辑，无 Taro 依赖
- `apps/feishu/src/stores/app-store.ts` — 应用状态 reducer，有 Taro storage 调用
- `apps/feishu/src/stores/session-store.ts` — 会话列表，纯 reducer，无 Taro 依赖
- `apps/feishu/src/stores/chat-store.ts` — 聊天消息，纯 reducer，无 Taro 依赖
- `apps/feishu/src/stores/terminal-store.ts` — 终端偏好，有 Taro storage 调用
- `apps/feishu/src/stores/command-store.ts` — 命令缓存，无 Taro 依赖
- `apps/feishu/src/stores/file-store.ts` — 目录树缓存，无 Taro 依赖
- `apps/feishu/src/stores/relay-store.ts` — RelayClient context wrapper，无 Taro 依赖
- `apps/feishu/src/app.tsx` — 应用入口，PhaseNav 实例化和接线参考

### Phase 9 PTY 链路（需对接）
- `apps/web/src/pages/pty-test.tsx` — 当前独立 WebSocket 实现，Phase 8 改造为使用统一管理器
- Phase 9 CONTEXT.md D-06 — binary 帧格式：1B sessionId 长度 + sessionId UTF-8 + PTY 数据
- Phase 9 CONTEXT.md D-26 — 客户端按 event.data 类型分发：ArrayBuffer → xterm.js，string → JSON
- Phase 9 CONTEXT.md D-43 — 客户端解析 binary 帧的具体步骤

### Phase 7 设计基础
- `apps/web/src/app.css` — 设计 token 定义，toast 组件需对齐
- `apps/web/src/app.tsx` — 当前简易 hash 路由，Phase 8 重写
- `apps/web/package.json` — react-router v7.14.1 已安装，需加 zustand

### Shared Package
- `packages/shared/src/schemas/envelope.ts` — MessageEnvelope 类型
- `packages/shared/src/schemas/relay-control.ts` — relay 控制消息类型（ProxyInfo 等）
- `packages/shared/src/schemas/session.ts` — 会话相关 schema
- `packages/shared/src/schemas/chat.ts` — 聊天消息 schema
- `packages/shared/src/schemas/tool.ts` — 工具调用 schema

### Requirements
- `.planning/REQUIREMENTS.md` — FRONT-09（phase-machine 适配）、FRONT-10（relay-store WebSocket 清理）

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **relay-client.ts, ensure-binding.ts**: 协议层服务，无 Taro 依赖，直接复制
- **所有纯净 stores**（chat/session/command/file）: reducer 逻辑可直接复用，只需改写为 zustand 形式
- **relay-store.ts**: React Context wrapper，改为 zustand 后不再需要
- **websocket.ts createNativeTask()**: 原生 WebSocket 包装已有参考实现，但需要扩展支持 binary
- **react-router v7.14.1**: 已安装在 apps/web，未使用
- **@cc-anywhere/shared**: 已配置为 devDependency，类型可直接引用

### Established Patterns
- ESM + TypeScript 全项目统一
- pnpm workspace monorepo
- zod schema 运行时校验
- vitest 测试框架
- Vite 构建 + 开发代理

### Integration Points
- `apps/web/src/app.tsx` — 重写为 react-router + 状态机 + WebSocket 接线
- `apps/web/src/pages/pty-test.tsx` — 改造为使用统一 WebSocket 管理器
- `apps/web/package.json` — 添加 zustand 依赖
- `apps/web/vite.config.ts` — 可能需要添加 @/ 路径别名配置
- `apps/web/tsconfig.app.json` — 添加 @/ 路径映射

</code_context>

<specifics>
## Specific Ideas

- Phase 8 的核心价值是让业务逻辑在浏览器中跑通，不依赖任何 Taro API。占位页面是验证手段，不是交付物
- websocket.ts 已有原生 WebSocket 实现（createNativeTask），但只处理 string 消息。Phase 8 需要扩展支持 binary 帧的接收和分发
- phase-machine 的 PhaseNav 接口是 Taro 隔离层，溶解后代码更直接但失去了 mock 测试的便利性。单元测试需要 mock zustand store 和 react-router
- use-screen-size 不迁移。浏览器有更好的原生方案（dvh、env(safe-area-inset-*)、visualViewport API），Phase 10 按需实现

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 08-business-logic-adaptation*
*Context gathered: 2026-04-16*
