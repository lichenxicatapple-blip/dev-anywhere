---
phase: 9
slug: pty-pipeline-full-chain
status: draft
shadcn_initialized: true
preset: new-york
created: 2026-04-15
---

# Phase 9 -- UI Design Contract

> `/pty-test` 诊断测试页的视觉和交互合约。本页面是全链路验证工具（D-09），非生产 UI。
> 由 gsd-ui-researcher 生成，gsd-ui-checker 验证。

---

## Design System

| Property | Value |
|----------|-------|
| Tool | shadcn (new-york style) |
| Preset | `new-york`, baseColor `neutral`, cssVariables `true` |
| Component library | Radix (via shadcn) |
| Icon library | 本阶段不使用图标 |
| Font (terminal) | `"Sarasa Fixed SC", ui-monospace, SFMono-Regular, Menlo, monospace` (`--font-mono`) |
| Font (UI) | `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` (`--font-sans`) |

Source: `apps/web/components.json`, `apps/web/src/app.css`

---

## Spacing Scale

已在 Phase 7 通过 Tailwind v4 默认 spacing scale 建立。本阶段使用子集：

| Token | Value | Usage |
|-------|-------|-------|
| xs | 4px | 状态指示灯与文字之间间距 |
| sm | 8px | 输入框内 padding、状态栏元素间距 |
| md | 16px | 状态栏整体 padding、表单元素间距 |
| lg | 24px | 不使用 |
| xl | 32px | 不使用 |
| 2xl | 48px | 不使用 |
| 3xl | 64px | 不使用 |

例外：xterm.js 容器不使用 spacing token，由 FitAddon 自动计算填满剩余空间。

---

## Page Layout

`/pty-test` 页面采用单列全屏布局，两个区域：

```
+-----------------------------------------------+
| [StatusBar] 连接状态栏 (固定高度 48px)           |
+-----------------------------------------------+
|                                                 |
|                                                 |
|           xterm.js 终端 (填满剩余空间)            |
|                                                 |
|                                                 |
+-----------------------------------------------+
```

### StatusBar (连接状态栏)

- 位置：页面顶部，`position: sticky; top: 0`
- 高度：48px（`h-12`）
- 背景：`--card` (#252526)
- 底部分割线：1px solid `--border` (#404040)
- 布局：`flex items-center gap-2 px-4`
- 内容从左到右：
  1. 状态指示灯（8x8px 圆形）
  2. 状态文字（`--foreground`，14px）
  3. 弹性空间（`flex-1`）
  4. Relay URL 输入框
  5. Session ID 输入框
  6. Connect 按钮

### StatusBar -- 输入区域

- **Relay URL 输入框**
  - `<input type="text">`
  - placeholder: `ws://localhost:3100/client`
  - 宽度：280px
  - 高度：32px
  - 背景：`--input` (#3C3C3C)
  - 文字：`--foreground` (#D4D4D4)，13px `--font-mono`
  - 边框：1px solid `--border` (#404040)
  - 圆角：`--radius` (4px)
  - focus 边框：`--ring` (#00D4AA)

- **Session ID 输入框**
  - `<input type="text">`
  - placeholder: `session-id`
  - 宽度：200px
  - 其余样式同 Relay URL 输入框

- **Connect 按钮**
  - 文字：Connect / Disconnect（根据连接状态切换）
  - 样式：shadcn Button variant `default`（`--primary` 背景 #00D4AA，`--primary-foreground` 文字 #1E1E1E）
  - 高度：32px
  - disabled 状态：连接中时禁用，opacity 0.5

### StatusBar -- 状态指示灯颜色

| 连接状态 | 指示灯颜色 | 状态文字 |
|---------|-----------|---------|
| disconnected | `--muted-foreground` (#808080) | Disconnected |
| connecting | `--color-status-working` (#4FC1FF) | Connecting... |
| connected | `--color-status-success` (#00D4AA) | Connected |
| error | `--color-status-error` (#F44747) | Error: {message} |

指示灯动画：`connecting` 状态使用 CSS `animation: pulse 1.5s ease-in-out infinite`。其余状态无动画。

### xterm.js 终端容器

- 容器：`div`，填满 StatusBar 以下的全部剩余空间（`flex-1`，`overflow: hidden`）
- xterm.js 通过 FitAddon 自适应容器尺寸
- 不显示自定义滚动条，使用 xterm.js 内置滚动
- 容器背景设为 `--background` (#1E1E1E)，避免 xterm.js 初始化前闪白

---

## xterm.js Theme Contract (D-40)

必须精确使用以下值，不得偏离：

```typescript
const theme = {
  background: "#1E1E1E",
  foreground: "#D4D4D4",
  cursor: "#D4D4D4",
  cursorAccent: "#00D4AA",
  selectionBackground: "#264F78",
  selectionForeground: undefined,
  // VS Code Dark+ ANSI 16 色
  black: "#000000",
  red: "#CD3131",
  green: "#0DBC79",
  yellow: "#E5E510",
  blue: "#2472C8",
  magenta: "#BC3FBC",
  cyan: "#11A8CD",
  white: "#E5E5E5",
  brightBlack: "#666666",
  brightRed: "#F14C4C",
  brightGreen: "#23D18B",
  brightYellow: "#F5F543",
  brightBlue: "#3B8EEA",
  brightMagenta: "#D670D6",
  brightCyan: "#29B8DB",
  brightWhite: "#E5E5E5",
};
```

Source: D-40 (CONTEXT.md), 09-RESEARCH.md Code Examples

### xterm.js 配置

| Property | Value | Source |
|----------|-------|--------|
| `scrollback` | 5000 | D-19 |
| `fontFamily` | `"Sarasa Fixed SC", ui-monospace, SFMono-Regular, Menlo, monospace` | `--font-mono` (app.css) |
| `fontSize` | 14 | RESEARCH.md Code Examples |
| `cursorBlink` | true | default |
| `disableStdin` | true | D-44 (只读) |

### 字体加载时序 (D-41)

初始化顺序必须为：
1. 加载 relay `/fonts/sarasa-fixed-sc/result.css` 样式表
2. `await document.fonts.ready`
3. 创建 Terminal 实例并 `open()`
4. `fitAddon.fit()`

在 `document.fonts.ready` resolve 之前，终端容器显示空白（背景色 #1E1E1E），不显示加载指示器。

---

## Typography

本阶段只有 StatusBar 使用 UI 文字，终端区域由 xterm.js 全权管理。

| Role | Size | Weight | Line Height | Font |
|------|------|--------|-------------|------|
| StatusBar 状态文字 | 14px | 400 (regular) | 1.5 | `--font-sans` |
| StatusBar 输入框文字 | 13px | 400 (regular) | 1.5 | `--font-mono` |
| StatusBar 按钮文字 | 14px | 500 (medium) | 1.0 | `--font-sans` |
| xterm.js 终端 | 14px | N/A (由 Sarasa Fixed SC 字体决定) | N/A (由 xterm.js 管理) | `--font-mono` |

Source: Phase 7 design tokens (app.css `--font-sans`, `--font-mono`)

---

## Color

本阶段 `/pty-test` 是全屏终端页面，配色方案以 xterm.js 终端为主体：

| Role | Value | Usage |
|------|-------|-------|
| Dominant (85%) | `--background` #1E1E1E | xterm.js 终端背景，页面背景 |
| Secondary (10%) | `--card` #252526 | StatusBar 背景 |
| Accent (5%) | `--primary` #00D4AA | Connect 按钮背景、连接成功指示灯、input focus 边框 |
| Destructive | `--destructive` #F44747 | 连接错误指示灯、错误状态文字 |

Accent 仅用于以下元素：
- Connect 按钮（`--primary` 背景）
- 连接成功状态指示灯
- 输入框 focus ring
- xterm.js cursorAccent

配色比例说明：普通 UI 页面是 60/30/10 分配。本页面因为 xterm.js 占据绝大部分视口面积，dominant 比例更高。这是正确的——终端测试页的核心就是终端本身。

Source: `apps/web/src/app.css` design tokens, D-40 (CONTEXT.md)

---

## Copywriting Contract

| Element | Copy |
|---------|------|
| Primary CTA | Connect（连接按钮，已连接时切换为 Disconnect） |
| 页面标题（浏览器 tab） | PTY Test -- CC Anywhere |
| Disconnected 状态 | Disconnected |
| Connecting 状态 | Connecting... |
| Connected 状态 | Connected |
| Error 状态 | Error: {error.message}（直接显示原始错误信息，不二次包装） |
| 空状态（终端区域） | 无文字。xterm.js 初始化后显示空终端（光标闪烁），等待 binary 数据写入。终端不主动显示 "Waiting for data" 等提示 |
| 输入框 placeholder - Relay URL | `ws://localhost:3100/client` |
| 输入框 placeholder - Session ID | `session-id` |

本页面不存在需确认的破坏性操作。Disconnect 直接执行，不需要确认弹窗。

Source: D-28, D-44 (CONTEXT.md), Claude's Discretion (CONTEXT.md 授权 UI 布局细节)

---

## Interaction States

### Connect/Disconnect 流程

```
[Disconnected] -- 用户点击 Connect -->
  验证 Relay URL 和 Session ID 非空
  如果为空：input 边框变为 --destructive，不发起连接
  如果有效：状态变为 [Connecting]，按钮 disabled
    --> WebSocket 连接成功：状态变为 [Connected]，按钮文字变为 Disconnect
    --> WebSocket 连接失败：状态变为 [Error]，按钮恢复可用，文字为 Connect

[Connected] -- 用户点击 Disconnect -->
  WebSocket.close()，状态变为 [Disconnected]

[Connected] -- WebSocket 意外断开 -->
  状态变为 [Error]，显示断开原因，按钮文字变为 Connect
```

### 输入框行为

- Relay URL 和 Session ID 输入框在 Connected 状态下设为 `readonly`（不禁用，但不可编辑），视觉上降低 opacity 到 0.7
- Enter 键在任一输入框内触发 Connect（等效于点击按钮）
- Session ID 输入框支持粘贴 nanoid 格式的 ID

### 窗口 Resize

- `window.onresize` 触发 `fitAddon.fit()` 重新计算终端尺寸
- 使用 `ResizeObserver` 监听容器尺寸变化（比 window.onresize 更可靠）
- 不向服务端发送 resize 事件——D-11 明确 PTY 为尺寸权威，客户端被动跟随

---

## Component Inventory

本阶段新增文件：

| File | Type | Description |
|------|------|-------------|
| `apps/web/src/pages/pty-test.tsx` | Page | /pty-test 全屏终端测试页 |
| `apps/web/src/lib/xterm-theme.ts` | Config | xterm.js 主题配置，导出 theme 对象 |

复用已有组件：

| Component | Source | Usage |
|-----------|--------|-------|
| `Button` | `@/components/ui/button` (shadcn) | Connect/Disconnect 按钮 |
| `Input` | `@/components/ui/input` (shadcn) | Relay URL / Session ID 输入框（如已安装；否则用原生 input + Tailwind 样式） |

需确认：Phase 7 是否已安装 shadcn `Input` 组件。如未安装，本阶段用原生 `<input>` 配合 Tailwind 类即可，不单独安装 shadcn Input。

### 路由注册

`app.tsx` 需要注册 `/pty-test` 路由。当前 `app.tsx` 直接渲染 `<TokenShowcase />`，无路由系统。Phase 9 的路由方案：

- 如果 Phase 8 先完成了 react-router 集成：复用其路由注册 `/pty-test`
- 如果 Phase 9 先于 Phase 8 执行（D-45）：使用简单的 hash 路由分发（`location.hash` 判断），或直接在 `app.tsx` 中条件渲染

具体方案由 planner 在 09-03 plan 中决定。

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | `Button` (已安装) | not required |
| 第三方 | 无 | N/A |

本阶段不使用任何第三方 shadcn registry。

---

## Accessibility Notes

- `/pty-test` 是开发者诊断工具，不面向最终用户。不要求 WCAG AA 合规
- xterm.js 有内置的无障碍支持（`aria-live` 区域），保持默认启用
- 状态指示灯不仅用颜色区分，还配有文字标签（Disconnected/Connecting/Connected/Error），满足色觉辨识需求

---

## Checker Sign-Off

- [ ] Dimension 1 Copywriting: PASS
- [ ] Dimension 2 Visuals: PASS
- [ ] Dimension 3 Color: PASS
- [ ] Dimension 4 Typography: PASS
- [ ] Dimension 5 Spacing: PASS
- [ ] Dimension 6 Registry Safety: PASS

**Approval:** pending
