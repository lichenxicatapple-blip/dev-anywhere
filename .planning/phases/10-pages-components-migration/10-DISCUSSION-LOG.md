# Phase 10: Pages + Components Migration - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in 10-CONTEXT.md — this log preserves the alternatives considered and the视角 shift during discussion.

**Date:** 2026-04-17
**Phase:** 10-pages-components-migration
**Areas discussed:** 切片与交付顺序 / Chat 页面拆分 / shadcn 映射与组件裁剪 / App Shell 与响应式 / (重置视角) 产品视觉定位 / 信息架构 / Chat 模式融合度 / 多会话桌面增强 / ToolApproval / InputBar / 新建 session Dialog / A11y 基线

---

## 讨论流程说明

讨论分两个阶段：

**阶段 1（迁移视角）**：围绕"如何把 Feishu 实现搬到 web"展开四个初始灰色区。过程中用户纠正："这次想做得更好，不一定拘泥于以前的实现形式"。阶段 1 的部分决策在阶段 2 被覆盖。

**阶段 2（重做视角）**：用户要求"结合刚刚所指定的目标，我们要不要把所有问题再重新梳理一次"。重置四个新的产品级灰色区：视觉定位、信息架构、Chat 模式融合度、多会话桌面增强。阶段 2 决策为最终权威。

---

## 阶段 1 — 初始四区（部分已被覆盖）

### 切片与交付顺序

| 问题 | 选项 | 用户选择 |
|------|------|---------|
| Plan 切片的粒度 | 每页 1 Plan / 功能垂直切片 / 基础层先行 | **每页 1 Plan（3 + 基础）** |
| 起步页面 | ProxySelect / SessionList / Chat | **ProxySelect** |
| 视觉验证 checkpoint | 每个 plan / 按页面 / phase 末尾 | **每个 plan 都做验证** |
| /pty-test 处置 | 保留为调试页 / 合并到 Chat | **保留为调试页** |

**锁定：** 5 plan 结构（10-01 Shell → 10-02 ProxySelect → 10-03 SessionList → 10-04 Chat JSON → 10-05 Chat PTY）；每 plan 视觉验证；pty-test 保留。阶段 2 追加可选 10-06（并排 tab）。

---

### Chat 页面拆分（第一轮）

| 问题 | 选项 | 用户选择 |
|------|------|---------|
| JSON 和 PTY 一个页面还是两个 | 同一 ChatPage `?mode=` / 两个独立页面 | **同一 ChatPage** |
| PTY 模式是否支持发送输入 | 只读 / 远程送键位 / 不加回车 | **远程送键位** |
| ToolApproval 呈现 | 嵌入消息流 / 底部 Sheet / Dialog | **底部 Sheet** |
| 消息流虚拟化 | 暂不用 / react-virtual | **react-virtual** |

**用户反问**："PTY 模式下 Chat 页是否支持发送输入？为什么会问我这个问题"

**修正**：查证代码后发现 `pty_input` IPC 消息、Feishu InputBar 已支持 PTY 输入、Phase 9 D-44 已明说 Phase 10 集成。该问题是伪二选一。

**重新提问**：InputBar 迁移方式（按原样 / 迁移后补充原始键位 / 只迁移）+ ToolApproval 两模式态度（保留双形态 / 统一 Sheet / 原型验证）

| 重新提问 | 用户选择 |
|---------|---------|
| PTY InputBar 方式 | **迁移后补充原始键位通道** |
| ToolApproval UI | **"刚刚我们是不是讨论过相关的设计？"**（提醒重复） |

**解决**：锁定第一轮的"底部 Sheet 统一"作为结论；随后阶段 2 在 NEW-4 细节讨论时再次被 D-23 覆盖为分级浮层。

---

### shadcn 映射与组件裁剪

| 问题 | 用户选择 |
|------|---------|
| shadcn 安装时机 | **Plan 10-01 一次性装全集** |
| Feishu 哪些组件砍掉 | **typewriter / safe-area-header / terminal-viewport / modal** 全部砍 |
| Markdown 栈 | **react-markdown + remark-gfm + rehype-highlight** |
| 消息气泡组件保留 | **保留并重命名对齐 shadcn 风格** |

**用户反馈**："以前飞书的确做过，但是这次想做得更好，不一定拘泥于以前的实现形式"

**影响**：气泡组件决策由"保留并重命名"重改为 D-20"自研 MessageBubble，不强制沿用 Feishu 拆分"。其他三项（安装时机、砍哪些、Markdown 栈）与重做视角兼容，保留。

---

### App Shell 与响应式（第一轮 — 被中断）

第一轮四个问题尚未全部作答，用户请求"结合刚刚所指定的目标，我们要不要把所有问题再重新梳理一次"。

**中断原因**：之前的提问框架一直以"Feishu 现状"为锚点，用户希望重置到产品需求视角。

---

## 阶段 2 — 重置后的产品级四区（最终权威）

### NEW-1: 产品定位与视觉基调

| 问题 | 选项 | 用户选择 |
|------|------|---------|
| 视觉定位（初次） | 开发者终端感 / 现代 SaaS / Claude 流式 | **用户反问：PTY 和 JSON 两模式是否无法统一要分开设计？** |
| 场景优先级 | 手机远程 > 桌面 / 桌面 > 手机 / 同等 | **手机和平板，电脑较少** |
| 主题切换 | 锁定深色 / 预留双主题 / 实现切换 | **锁定深色** |

**回应用户反问**：澄清 PTY 终端视觉由 xterm.js 主题决定（Phase 9 已锁），视觉基调决策实际作用于 JSON 模式 + 两模式共用 chrome。基于澄清重问：

| 问题 | 选项 | 用户选择 |
|------|------|---------|
| JSON + chrome 视觉基调 | 与终端对齐开发者工具感+琥珀 / 现代 SaaS / 轻量流式 | **开发者工具感 + 琥珀色 accent** |
| 平板定位 | 大屏手机 / 小桌面启用 master-detail / 自适应 | **小桌面：同步启用 master-detail** |

**最终决策 D-01 ~ D-05**：开发者工具感 + 终端美学相容 / accent 从 #00D4AA 改为 #D4A574（覆盖 Phase 7 D-01）/ radius 收小 / 锁定深色 / Sarasa Fixed SC 字体。

---

### NEW-2: 信息架构

| 问题 | 选项 | 用户选择 |
|------|------|---------|
| 移动端结构 | 纵深三页 / 合并两页 / 单页 + Sheet | **纵深三页 ProxySelect → SessionList → Chat** |
| Master-Detail 分区 | 右主+左 Session / 三栏 / 上下 | **左 SessionList + 主区 Chat** |
| Onboarding 形式 | 空状态内嵌 / 独立页 | **空状态内嵌** |

**最终决策 D-06 ~ D-11**：移动端三页 + 桌面/平板 master-detail；ProxySelect 在桌面是侧栏控件（非页）；组件双形态统一。

---

### NEW-3: Chat 两模式的融合度

| 问题 | 选项 | 用户选择 |
|------|------|---------|
| 两模式关系 | 严格二选一 / 可切换 / 融合 | **严格二选一** |
| mode 指定时机 | 创建时冻结 / proxy 自动识别 | **创建时冻结** |

**最终决策 D-12 ~ D-14**：一次只看一种模式，session 创建时冻结。

---

### NEW-4: 多会话桌面增强

| 问题 | 选项 | 用户选择 |
|------|------|---------|
| 平板增强功能（multiSelect） | 即时切换 / 可折叠 / Cmd+K / 并排 tab | **全部四项选中** |
| 侧栏内容 | 紧凑型 / 丰满型（带预览） | **紧凑型（带预览图查看）** |

**预览对比**：
- 紧凑型：proxy dropdown + session 列表 + 新建按钮
- 丰满型：+ 顶部 relay 连接状态 + 底部设置/字号条

**最终决策 D-15 ~ D-19**：侧栏即时切换、可折叠、Cmd+K palette、并排 tab；侧栏走紧凑型，设置入口放全局 header。

---

### 细节决策（四项）

| 问题 | 选项 | 用户选择 |
|------|------|---------|
| ToolApproval 层级 | 分级按钮 + 详情 + 白名单 / 统一展开 / 纯按钮 | **分级：激进按钮 + 详情展开 + 白名单** |
| InputBar 功能点（multiSelect） | 多行/Enter / 斜杠浮层 / ↑历史 / 文件选择器 | **全部四项** |
| 新建 session Dialog 字段 | 最小 name+mode+CWD / 完整+permission+resume | **最小字段** |
| A11y 基线 | 每 plan 自带 / 专工 plan / 不做 | **每个 plan 自带** |

**最终决策 D-22 ~ D-28（ToolApproval / InputBar / Session Dialog / A11y）**。

**覆盖声明**：D-23 把阶段 1 锁定的"ToolApproval 底部 Sheet 统一"改为"JSON 嵌入消息流 + PTY 浮层卡"，因为分级+快捷键+白名单的设计不适合底部 Sheet 形态。

---

## Claude 讨论中的错误与修正（审计追溯）

| 错误 | 纠正机制 |
|------|---------|
| 问 "PTY 模式是否支持发送输入"（Phase 9 D-44 已明说 Phase 10 集成，pty_input 通道已存在） | 查证代码后承认误问，重新设计为迁移后补充原始键位的升级决策（D-21） |
| 把 Feishu 现状当锚点反复问"要不要保留"（迁移视角绑架） | 用户要求重新梳理，切到产品重做视角，元决策 D-META-01 记录该立场 |
| 阶段 1 锁定的"底部 Sheet"未考虑 PTY 模式视口紧张 | 阶段 2 细节讨论中 D-23 覆盖为分级浮层，JSON/PTY 各适配 |
| 重复问 ToolApproval（用户提醒"刚刚我们是不是讨论过相关的设计"） | 锁定第一轮答案推进，避免第三次询问 |

## Deferred Ideas

见 10-CONTEXT.md 的 `<deferred>` 段。
