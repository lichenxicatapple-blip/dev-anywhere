# Phase 7: Project Scaffold + Design Tokens - Context

**Gathered:** 2026-04-15
**Status:** Ready for planning

<domain>
## Phase Boundary

创建 `apps/web`——一个 Vite + React + Tailwind CSS v4 + shadcn/ui 项目，定义设计 token（颜色、字体、间距、圆角），配置开发代理，渲染 Token 展示页验证视觉效果。

不包含：页面迁移（Phase 10）、业务逻辑迁移（Phase 8）、xterm.js 集成（Phase 9）、PWA 功能（Phase 12+）。

</domain>

<decisions>
## Implementation Decisions

### Color Palette
- **D-01:** 三个锚点色已定：#1E1E1E surface、#D4D4D4 text、#00D4AA accent
- **D-02:** 多层级暗色表面采用 VS Code 风格灰阶分层：#1E1E1E page bg → #252526 card → #2D2D2D popover → #3C3C3C input → #404040 border
- **D-03:** 状态色（working/success/warning/error）由 Claude 根据 #00D4AA accent 和暗色主题统一配色，要求视觉和谐不刺眼

### Typography
- **D-04:** UI 文本使用系统字体栈：`system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
- **D-05:** 终端和代码展示使用 Sarasa Fixed SC 等宽字体。该字体已通过 cn-font-split 做 unicode-range 子集化（约 230 个 woff2 文件，16MB），浏览器按需加载

### Font Loading
- **D-06:** 复用 relay 现有的 `/fonts/` 静态文件服务。Web app 在 index.html 中静态引用 `<link rel="stylesheet" href="/fonts/sarasa-fixed-sc/result.css">`
- **D-07:** 开发模式通过 Vite `server.proxy` 把 `/fonts/*` 请求代理到 relay，解决跨域。生产环境 relay 同时 serve SPA 和字体，同源无需代理

### Visual Style
- **D-08:** 紧凑工具风：4px 圆角、紧凑间距（12px padding）、1px 细边框。接近 VS Code / 终端工具的视觉语言，信息密度高
- **D-09:** shadcn/ui 组件按紧凑风格定制 CSS variables（radius、spacing），不使用默认的圆润风格

### Responsive
- **D-10:** Mobile-first 三档响应式布局：
  - Mobile (<640px)：iPhone/Android 竖屏，单列，全屏终端
  - Tablet (640-1024px)：iPad 竖屏 / 手机横屏，放大间距
  - Desktop (>1024px)：Mac/Windows 桌面，利用横向空间
- **D-11:** 使用 Tailwind v4 默认断点（sm:640px, md:768px, lg:1024px），mobile-first 渐进增强

### Scaffold Page
- **D-12:** 初始页面为 Token 展示页：展示完整颜色色板、字体样式、间距尺度、shadcn/ui Button 组件，用于快速验证设计 token 生效

### Claude's Discretion
- 状态色的具体色值选择，要求与暗色主题和 #00D4AA accent 视觉统一
- Tailwind v4 @theme 中设计 token 的组织结构和命名约定
- shadcn/ui 初始安装哪些组件（至少包含 Button）
- Vite + React + TypeScript 项目的具体配置细节

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project Architecture
- `pnpm-workspace.yaml` — monorepo workspace 配置，apps/web 需要加入
- `package.json` — 根 package.json，了解现有 scripts 和 devDependencies
- `tsconfig.json` — TypeScript 项目引用配置

### Relay Font Serving
- `apps/relay/src/server.ts` L36-41 — relay 已实现 `/fonts/` 静态文件服务，从 `~/.cc-anywhere/relay-data/fonts/` 读取
- `apps/feishu/src/app.tsx` L46-54 — 飞书 app 动态注入字体 CSS 的参考实现

### Design Reference (Feishu App)
- `apps/feishu/src/app.css` — 现有 CSS 变量体系（颜色、间距、气泡宽度），新 app 不沿用但可参考结构
- `apps/feishu/src/app.config.ts` — 页面注册和窗口配置参考

### Shared Package
- `packages/shared/src/index.ts` — 共享 schema 导出，apps/web 需要依赖

### Requirements
- `.planning/REQUIREMENTS.md` — FRONT-01（项目搭建）、FRONT-02（设计 token）、DEPLOY-02（开发代理）

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Relay font serving** (`apps/relay/src/server.ts`): `/fonts/` 静态服务已就绪，新 app 直接引用
- **Sarasa Fixed SC 字体文件** (`~/.cc-anywhere/relay-data/fonts/sarasa-fixed-sc/`): cn-font-split 子集化完成，含 result.css
- **packages/shared**: 消息 schema、类型定义，apps/web 直接依赖

### Established Patterns
- ESM + TypeScript 全项目统一
- pnpm workspace monorepo（packages/* + apps/*）
- tsup 打包 proxy 和 relay，Vite 打包前端
- pino 结构化 JSON 日志（server 端）
- zod schema 运行时校验

### Integration Points
- `pnpm-workspace.yaml` — 添加 apps/web
- `tsconfig.json` — 添加 apps/web 项目引用
- `package.json` — 根 scripts 可能需要添加 web 相关命令
- Vite `server.proxy` — 代理 WebSocket 和 `/fonts/` 到 relay

</code_context>

<specifics>
## Specific Ideas

- 用户在 Mac、Windows、iPad、iPhone 和 Android 上使用，响应式必须覆盖全平台
- PTY 远程查看是核心诉求，Sarasa Fixed SC 中英文严格等宽对终端渲染至关重要
- 视觉方向与飞书 app 完全不同：从蓝主色+深紫背景+白卡面，转向 VS Code 风格暗灰色系+青绿 accent

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 07-project-scaffold-design-tokens*
*Context gathered: 2026-04-15*
