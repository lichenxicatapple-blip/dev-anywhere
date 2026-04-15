# CC Anywhere: Feishu Taro to React SPA + PWA Migration Plan

**Created:** 2026-04-15
**Source:** apps/feishu (Taro 3.6 mini program)
**Target:** apps/web (Vite + React + TypeScript + Tailwind CSS v4 + PWA)
**Status:** Draft - Pending review

---

## 1. New Project Structure

```
apps/web/
  index.html                    # Vite entry HTML (mounts #root)
  vite.config.ts                # Vite + Tailwind + PWA plugin config
  tsconfig.json                 # TypeScript config (extends root)
  package.json                  # Dependencies, scripts
  public/
    icons/
      icon-192.png              # PWA icon 192x192
      icon-512.png              # PWA icon 512x512
  src/
    main.tsx                    # React entry: createHashRouter + RouterProvider
    app.tsx                     # App shell: providers, WebSocket init, Outlet
    app.css                     # @import "tailwindcss" + @theme + global animations
    routes.tsx                  # Route table definitions
    pages/
      proxy-select/
        index.tsx               # Proxy selection page
      session-list/
        index.tsx               # Session list page
      chat/
        index.tsx               # Chat page (PTY + JSON dual mode)
    components/
      assistant-bubble/
        index.tsx
      back-to-bottom/
        index.tsx
      chat-bubble-list/
        index.tsx
      directory-picker/
        index.tsx
        path-utils.ts           # Pure utility, copy verbatim
      empty-state/
        index.tsx
      file-path-picker/
        index.tsx
      input-bar/
        index.tsx
      markdown-view/
        index.tsx
      modal/
        index.tsx
      proxy-list-item/
        index.tsx
      quote-preview-bar/
        index.tsx
      safe-area-header/
        index.tsx               # Rewrite: no safe area insets in browser
      session-list-item/
        index.tsx
      slash-command-picker/
        index.tsx
      status-line/
        index.tsx
      terminal-viewport/
        index.tsx
      toast/
        index.tsx
      tool-approval-card/
        index.tsx
      tool-call-card/
        index.tsx
      typewriter/
        index.tsx
      user-bubble/
        index.tsx
    hooks/
      use-screen-size.ts        # Rewrite: window.resize instead of Taro API
    services/
      ensure-binding.ts         # Copy verbatim
      message-parser.ts         # Copy verbatim
      relay-client.ts           # Copy verbatim
      websocket.ts              # Adapt: strip Taro codepath, native WebSocket only
    stores/
      app-store.ts              # Adapt: localStorage instead of Taro storage
      chat-store.ts             # Copy verbatim
      command-store.ts          # Copy verbatim
      file-store.ts             # Copy verbatim
      relay-store.ts            # Copy verbatim
      session-store.ts          # Copy verbatim
      terminal-store.ts         # Adapt: localStorage instead of Taro storage
    utils/
      format-session-name.ts    # Copy verbatim
      relative-time.ts          # Copy verbatim
      summarize-tool-input.ts   # Copy verbatim
      text-truncate.ts          # Copy verbatim
    types/
      stream-json.ts            # Copy verbatim
    phase-machine.ts            # Copy verbatim
    __tests__/                  # Test files (most copy, one adapt)
      app-store.test.ts         # Adapt: remove Taro mock
      directory-picker.test.ts
      ensure-binding.test.ts
      format-session-name.test.ts
      input-bar-logic.test.ts
      input-bar-pure.test.ts
      message-parser.test.ts
      phase-machine.test.ts
      relay-client.test.ts
      session-store.test.ts
      summarize-tool-input.test.ts
      use-screen-size.test.ts
      utils.test.ts
```

**Config files:**

- `vite.config.ts`: Vite + `@tailwindcss/vite` + `@vitejs/plugin-react` + `vite-plugin-pwa`, `@` alias, RELAY_URL define, dev server proxy
- `tsconfig.json`: Extends monorepo root, `paths: { "@/*": ["./src/*"] }`, `jsx: "react-jsx"`, `target: "ES2022"`
- `index.html`: Minimal HTML with `<div id="root">`, viewport meta, dark background
- `package.json`: `@cc-anywhere/shared` workspace reference, build/dev/test scripts

---

## 2. Module Inventory: Copy / Adapt / Rewrite / Drop

### COPY (26 files) - Zero Taro dependency, copy verbatim

| File | Reason |
|------|--------|
| `phase-machine.ts` | Pure logic, no Taro imports; PhaseNav interface abstracts navigation |
| `services/ensure-binding.ts` | Only imports local types, no Taro |
| `services/message-parser.ts` | Pure parser, imports only local types |
| `services/relay-client.ts` | Only depends on WebSocketManager type and @cc-anywhere/shared |
| `stores/chat-store.ts` | React context only, no Taro |
| `stores/command-store.ts` | React context only, no Taro |
| `stores/file-store.ts` | React context only, no Taro |
| `stores/relay-store.ts` | React context only, no Taro |
| `stores/session-store.ts` | React context only, no Taro |
| `types/stream-json.ts` | Pure type definitions |
| `utils/format-session-name.ts` | Pure function, no imports |
| `utils/relative-time.ts` | Pure function, no imports |
| `utils/summarize-tool-input.ts` | Pure function, no imports |
| `utils/text-truncate.ts` | Pure function, no imports |
| `components/directory-picker/path-utils.ts` | Pure path utilities, no Taro |
| `components/modal/index.tsx` | Uses createPortal + native DOM, no Taro imports |
| `components/toast/index.tsx` | Uses native DOM rendering, no Taro imports |
| `__tests__/directory-picker.test.ts` | Tests pure functions |
| `__tests__/ensure-binding.test.ts` | Tests pure logic with mocks |
| `__tests__/format-session-name.test.ts` | Tests pure function |
| `__tests__/input-bar-logic.test.ts` | Tests pure computation |
| `__tests__/input-bar-pure.test.ts` | Tests pure functions |
| `__tests__/message-parser.test.ts` | Tests pure parser |
| `__tests__/phase-machine.test.ts` | Tests pure state machine logic |
| `__tests__/relay-client.test.ts` | Tests with WebSocketManager mock |
| `__tests__/session-store.test.ts` | Tests pure reducer |
| `__tests__/summarize-tool-input.test.ts` | Tests pure function |
| `__tests__/utils.test.ts` | Tests pure utility functions |

### ADAPT (28 files) - Has Taro imports, business logic reusable, mechanical replacement

| File | Taro Imports | Web Replacement |
|------|-------------|----------------|
| `app.tsx` | `Taro` (navigation, storage, useDidShow) | react-router `navigate()`, `localStorage`, `visibilitychange` event |
| `services/websocket.ts` | `Taro` (connectSocket) | Strip Taro codepath, keep native WebSocket only |
| `stores/app-store.ts` | `Taro` (getStorageSync, setStorageSync, removeStorageSync) | `localStorage` API |
| `stores/terminal-store.ts` | `Taro` (getStorageSync) | `localStorage.getItem()` |
| `hooks/use-screen-size.ts` | `Taro` (getSystemInfoSync, onWindowResize, offWindowResize) | `window.innerWidth/Height`, `resize` event listener |
| `pages/chat/index.tsx` | `View`, `Text`, `Taro`, `useRouter` | `div`, `span`, react-router `useParams`+`useSearchParams` |
| `pages/proxy-select/index.tsx` | `View`, `Text`, `Taro`, `usePullDownRefresh` | `div`, `span`, remove pull-down-refresh |
| `pages/session-list/index.tsx` | `View`, `Text`, `ScrollView`, `Taro` | `div`, `span`, `div` with overflow-auto |
| `components/assistant-bubble/index.tsx` | `View`, `Text` | `div`, `span` |
| `components/back-to-bottom/index.tsx` | `View` | `div` |
| `components/chat-bubble-list/index.tsx` | `View`, `Text`, `ScrollView` | `div`, `span`, `div` with overflow-auto |
| `components/directory-picker/index.tsx` | `View`, `Text`, `ScrollView`, `Input` | `div`, `span`, `div` overflow-auto, `input` |
| `components/empty-state/index.tsx` | `View`, `Text` | `div`, `span` |
| `components/file-path-picker/index.tsx` | `View`, `Text`, `ScrollView` | `div`, `span`, `div` overflow-auto |
| `components/input-bar/index.tsx` | `View`, `Text`, `Input` | `div`, `span`, `input` (e.detail.value -> e.target.value) |
| `components/markdown-view/index.tsx` | `View`, `RichText`, `ScrollView` | `div`, `div` with dangerouslySetInnerHTML, `div` overflow-auto |
| `components/proxy-list-item/index.tsx` | `View`, `Text` | `div`, `span` |
| `components/quote-preview-bar/index.tsx` | `View`, `Text` | `div`, `span` |
| `components/safe-area-header/index.tsx` | `View`, `Text`, `Taro` (navigateBack) | `div`, `span`, react-router `navigate(-1)` |
| `components/session-list-item/index.tsx` | `View`, `Text`, `CommonEventFunction` | `div`, `span`, `React.TouchEvent`/`React.MouseEvent` |
| `components/slash-command-picker/index.tsx` | `View`, `Text`, `ScrollView` | `div`, `span`, `div` overflow-auto |
| `components/status-line/index.tsx` | `View` | `div` |
| `components/terminal-viewport/index.tsx` | `View`, `Text` | `div`, `span` |
| `components/tool-approval-card/index.tsx` | `View`, `Text` | `div`, `span` |
| `components/tool-call-card/index.tsx` | `View`, `Text` | `div`, `span` |
| `components/typewriter/index.tsx` | `View`, `Text` | `div`, `span` |
| `components/user-bubble/index.tsx` | `View`, `Text` | `div`, `span` |
| `__tests__/app-store.test.ts` | `Taro` (vi.mock) | Replace mock with localStorage mock |
| `__tests__/use-screen-size.test.ts` | Tests pure functions only | Likely copy, but verify after use-screen-size rewrite |

### REWRITE (1 file) - Fundamentally different in web context

| File | Reason |
|------|--------|
| `hooks/use-screen-size.ts` | Taro.getSystemInfoSync/onWindowResize have no 1:1 equivalent; need full rewrite using window.resize, statusBarHeight=0, safeArea computed from viewport |

### DROP (4 files) - Taro-only config, no web equivalent

| File | Reason |
|------|--------|
| `app.config.ts` | Taro app config (pages, window, ext), replaced by react-router route table |
| `pages/chat/index.config.ts` | Taro page config (navigationStyle, disableScroll), no equivalent needed |
| `pages/proxy-select/index.config.ts` | Taro page config (enablePullDownRefresh), no equivalent needed |
| `pages/session-list/index.config.ts` | Taro page config (navigationBarTitleText), handled by document.title |

### CSS files (22 files, 2784 lines) - Convert to Tailwind utility classes

All CSS files from `apps/feishu/src/` will be migrated to Tailwind during the CSS conversion phase. They are not "copied" or "dropped" -- they are transformed. See Section 5 for the detailed strategy.

---

## 3. Taro Component to HTML Element Mapping Table

| Taro Component | HTML Equivalent | Prop Changes | Usage Count | Notes |
|---------------|----------------|--------------|-------------|-------|
| `<View>` | `<div>` | `className` stays, `onClick` stays | ~200+ | Direct replacement, most common |
| `<Text>` | `<span>` | `selectable` -> no equivalent (browser text is selectable by default) | ~80+ | Direct replacement |
| `<ScrollView>` | `<div className="overflow-auto">` | Remove `scrollY`/`scrollX` props; use CSS `overflow-y-auto`/`overflow-x-auto` | ~6 | chat-bubble-list, session-list, directory-picker, file-path-picker, slash-command-picker, markdown-view |
| `<RichText nodes={html}>` | `<div dangerouslySetInnerHTML={{__html: html}}>` | `nodes` string -> `dangerouslySetInnerHTML` | 1 | markdown-view only |
| `<Input>` | `<input>` | `onInput` event: `e.detail.value` -> `e.target.value`; `onConfirm` -> `onKeyDown` Enter check; `confirmType` -> no equivalent | 2 | input-bar, directory-picker |
| `<Image>` | `<img>` | `mode` prop -> CSS `object-fit` | 0 | Not currently used in codebase |

**ScrollView specific prop removal:**

| Taro Prop | Web Equivalent |
|-----------|---------------|
| `scrollY` | `className="overflow-y-auto"` (CSS, always on) |
| `scrollX` | `className="overflow-x-auto"` (CSS) |
| `scrollWithAnimation` | `scroll-behavior: smooth` (CSS) |
| `scrollTop` | `element.scrollTop = value` (imperative) |
| `onScroll` | Standard `onScroll` event, but `e.currentTarget.scrollTop` instead of `e.detail.scrollTop` |
| `onScrollToLower` | Intersection Observer or scroll position check |
| `enhanced` | Remove (Taro-specific optimization) |

---

## 4. Taro API to Web API Replacement Table

| Taro API | Web Equivalent | Files Affected | Notes |
|----------|---------------|----------------|-------|
| `Taro.navigateTo({ url })` | `navigate(path)` | app.tsx, proxy-select, session-list, phase-machine nav | react-router `useNavigate()` |
| `Taro.reLaunch({ url })` | `navigate(path, { replace: true })` | app.tsx, chat/index.tsx, phase-machine nav | Replace entire history stack |
| `Taro.navigateBack()` | `navigate(-1)` | safe-area-header, chat | Numeric arg = history.back() |
| `Taro.getStorageSync(key)` | `localStorage.getItem(key) \|\| ""` | app-store (loadClientId, cleanStorage), terminal-store (loadFontSizeIndex), app.tsx, chat, proxy-select, session-list | Note: returns `null` not `""`, need `\|\| ""` |
| `Taro.setStorageSync(key, val)` | `localStorage.setItem(key, JSON.stringify(val))` | app-store, chat, proxy-select, session-list | For non-string values, JSON.stringify |
| `Taro.removeStorageSync(key)` | `localStorage.removeItem(key)` | app-store (cleanStorage), chat | Direct replacement |
| `Taro.getCurrentPages()` | `window.location.hash` or `useLocation()` | app.tsx (getCurrentPath in nav object) | `hash.replace(/^#/, "")` gives current path |
| `Taro.useDidShow()` | `useEffect` + `visibilitychange` event | app.tsx | Re-acquire WebSocket on tab return |
| `useRouter()` | `useParams()` + `useSearchParams()` | chat/index.tsx | `router.params.sessionId` -> `searchParams.get("sessionId")` |
| `usePullDownRefresh()` | Remove; use refresh button or manual trigger | proxy-select | Browser has no native pull-down-refresh |
| `Taro.stopPullDownRefresh()` | Remove | proxy-select | N/A in browser |
| `Taro.onWindowResize(cb)` | `window.addEventListener("resize", cb)` | use-screen-size.ts | Standard DOM event |
| `Taro.offWindowResize(cb)` | `window.removeEventListener("resize", cb)` | use-screen-size.ts | Standard DOM event |
| `Taro.getSystemInfoSync()` | `{ windowWidth: window.innerWidth, windowHeight: window.innerHeight }` | use-screen-size.ts | No deviceType/statusBarHeight/safeArea in browser |
| `Taro.connectSocket({ url })` | `new WebSocket(url)` | websocket.ts | Already has native WebSocket codepath |
| `Taro.getApp().tt?.setWindowSize()` | Remove | chat/index.tsx (handleWindowToggle) | Feishu desktop-specific, no web equivalent |
| `Taro.setNavigationBarTitle()` | `document.title = title` | session-list | Standard DOM |
| `CommonEventFunction` type | `React.TouchEvent \| React.MouseEvent` | session-list-item | Type-only change |
| `declare const RELAY_URL` (defineConstants) | `define: { RELAY_URL: JSON.stringify(...) }` in vite.config.ts | websocket.ts, app.tsx | Vite `define` requires JSON.stringify |

**Navigation helper function for URL format conversion:**

```typescript
// Taro URLs: /pages/chat/index?sessionId=xxx
// Hash router: /pages/chat?sessionId=xxx (no /index suffix)
function toWebPath(taroUrl: string): string {
  return taroUrl.replace(/\/index(\?|$)/, "$1");
}
```

**Updated nav object for phase-machine.ts (in app.tsx):**

```typescript
const nav = {
  reLaunch: (url: string) => navigate(toWebPath(url), { replace: true }),
  navigateTo: (url: string) => navigate(toWebPath(url)),
  showToast: (title: string) => showToast(title),
  getStorageSync: (key: string) => localStorage.getItem(key) || "",
  removeStorageSync: (key: string) => localStorage.removeItem(key),
  getCurrentPath: () => window.location.hash.replace(/^#/, ""),
};
```

This means `phase-machine.ts` requires zero changes.

---

## 5. CSS Migration Strategy (750px to Tailwind)

### Design Width Analysis

Taro config uses `designWidth: 750` with pxtransform. In H5 mode, Taro converts 750-scale px values to rem. In the web version, Tailwind utility classes replace all CSS.

**Conversion formula:** `real_px = taro_px / 2` (750 design width on ~375px device)

**app.css exception:** Uses real pixel values via CSS variables (4px, 8px, 16px, etc.). No conversion needed -- these map directly to Tailwind spacing.

### CSS File Inventory

| File | Lines | Complexity | Notes |
|------|-------|-----------|-------|
| `app.css` | 104 | Simple | CSS variables + keyframes, real px values, migrate to `@theme` + Tailwind |
| `components/assistant-bubble/index.css` | 112 | Medium | Dark theme bubble styles, some 750-scale values |
| `components/back-to-bottom/index.css` | 37 | Simple | Float button positioning |
| `components/chat-bubble-list/index.css` | 79 | Medium | Scroll container, load-more styles |
| `components/directory-picker/index.css` | 257 | Complex | Modal overlay, breadcrumb, tree list, input |
| `components/empty-state/index.css` | 37 | Simple | Centered text layout |
| `components/file-path-picker/index.css` | 135 | Medium | Tree navigation styles |
| `components/input-bar/index.css` | 119 | Medium | Input field, buttons, 750-scale button sizes |
| `components/markdown-view/index.css` | 167 | Complex | Code blocks, syntax highlighting, prose styles |
| `components/modal/index.css` | 124 | Medium | Overlay, card, buttons |
| `components/proxy-list-item/index.css` | 34 | Simple | Card layout with status dot |
| `components/quote-preview-bar/index.css` | 53 | Simple | Preview bar above input |
| `components/safe-area-header/index.css` | 53 | Simple | Fixed header, back button chevron |
| `components/session-list-item/index.css` | 207 | Complex | Swipe gesture, dual-line layout, status dots, mode badges |
| `components/slash-command-picker/index.css` | 104 | Medium | Dropdown list, highlight |
| `components/status-line/index.css` | 64 | Simple | 4px color bar with animations |
| `components/terminal-viewport/index.css` | 25 | Simple | Monospace grid, dark background |
| `components/toast/index.css` | 63 | Simple | Top-bar toast animation |
| `components/tool-approval-card/index.css` | 206 | Complex | Card layout, code preview, action buttons, PTY overlay |
| `components/tool-call-card/index.css` | 89 | Medium | Collapsible card |
| `components/typewriter/index.css` | 27 | Simple | Cursor blink animation |
| `components/user-bubble/index.css` | 118 | Medium | Right-aligned bubble, quote block |
| `pages/chat/index.css` | 270 | Complex | Page layout, settings panel, loading overlay, dark theme |
| `pages/proxy-select/index.css` | 78 | Simple | Page layout, connecting state |
| `pages/session-list/index.css` | 222 | Complex | Page layout, FAB, directory picker modal, history groups |

**Total: 22 CSS files, 2784 lines**

### 750-Scale Value to Tailwind Mapping

| 750-scale px | Real px | Tailwind Utility | Example Usage |
|-------------|---------|-----------------|---------------|
| 16px | 8px | `p-2`, `gap-2`, `text-[8px]` | Small spacing |
| 20px | 10px | `p-2.5`, `text-[10px]` | Small text |
| 22px | 11px | `text-[11px]` | Small caption text |
| 24px | 12px | `p-3`, `gap-3`, `text-xs` | Standard spacing |
| 28px | 14px | `text-sm` | Body text |
| 30px | 15px | `p-[15px]` | Intermediate spacing |
| 32px | 16px | `p-4`, `text-base` | Standard padding, base text |
| 36px | 18px | `rounded-2xl`, `text-lg` | Border radius |
| 40px | 20px | `p-5`, `text-xl` | Section spacing |
| 48px | 24px | `p-6`, `w-6 h-6` | Icon containers |
| 60px | 30px | `p-[30px]` | Large spacing |
| 72px | 36px | `w-9 h-9` | Button size |
| 80px | 40px | `w-10 h-10` | Large button |
| 100px | 50px | `w-[50px]` | Custom sizes |
| 160px | 80px | `w-20` | Large elements |

### Dark Mode Migration

**Current pattern:**
```css
.chat-page-dark .component { color: #fff; }
```

**Tailwind pattern:**
```html
<!-- Set on <html> element since app is dark-themed by default -->
<html class="dark">
```
```tsx
<div className="text-white dark:text-white">
```

Since the app is dark-themed by default, the simplest approach is to design dark-first and add light mode later if needed. Most colors can be set directly without the `dark:` prefix.

### app.css CSS Variables to Tailwind @theme Migration

```css
/* Current app.css :root variables */
:root {
  --color-primary: #1890FF;
  --color-success: #52C41A;
  --color-warning: #FAAD14;
  --color-error: #FF4D4F;
  /* ... more */
}

/* Tailwind v4 @theme directive equivalent */
@import "tailwindcss";

@theme {
  --color-primary: #1890FF;
  --color-success: #52C41A;
  --color-warning: #FAAD14;
  --color-error: #FF4D4F;
  --color-working: #1890FF;
  --color-terminated: #999999;
  --color-surface: #FFFFFF;
  --color-surface-secondary: #F5F5F5;
  --color-terminal-bg: #1E1E1E;
  --color-text-primary: #333333;
  --color-text-secondary: #999999;
  --color-border: #E8E8E8;
  --color-border-light: #F0F0F0;
}
```

These become usable as `bg-primary`, `text-error`, `border-border`, etc.

### Keyframe Animations

The 5 keyframe animations in app.css (`pulse`, `breathing`, `sweepRight`, `bubbleEntranceLeft`, `bubbleEntranceRight`) will be kept as custom CSS in app.css alongside the Tailwind import. Tailwind v4 supports arbitrary animation names via `animate-[name]` or they can be registered via `@theme`.

---

## 6. PWA Configuration

### manifest.json (via vite-plugin-pwa)

```typescript
// In vite.config.ts VitePWA plugin config
manifest: {
  name: "CC Anywhere",
  short_name: "CC Anywhere",
  description: "Remote Claude Code interaction from any device",
  theme_color: "#1A1A2E",
  background_color: "#1A1A2E",
  display: "standalone",
  orientation: "any",
  start_url: "/",
  scope: "/",
  icons: [
    {
      src: "/icons/icon-192.png",
      sizes: "192x192",
      type: "image/png",
    },
    {
      src: "/icons/icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any maskable",
    },
  ],
}
```

### Service Worker Strategy

- **Generator:** `generateSW` (Workbox, auto-generated by vite-plugin-pwa)
- **Update behavior:** `registerType: "autoUpdate"` -- activate new service workers immediately, no user prompt
- **Caching rules:**
  - `CacheFirst` for static assets (JS, CSS, fonts, icons) with 30-day expiration
  - `NetworkFirst` or skip caching for API/dynamic data
  - Do NOT cache WebSocket connections (Workbox only intercepts HTTP fetch)
- **Offline shell:** `navigateFallback: "index.html"` returns the SPA shell when offline
- **Precache:** Vite build output is automatically precached by Workbox

### What NOT to Cache

- WebSocket connections (`ws://`, `wss://`) -- not HTTP, Workbox cannot intercept
- Dynamic API responses from relay health endpoint
- Font files from relay server (served from relay data dir, not bundled)

### Future PWA Capabilities

**Screen Wake Lock API** (keep screen awake during active sessions):
```typescript
// Acquire when session is active, release on visibility change
if ("wakeLock" in navigator) {
  const lock = await navigator.wakeLock.request("screen");
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible") {
      await navigator.wakeLock.request("screen");
    }
  });
}
```

**Web Speech API** (voice mode, future feature):
- `SpeechSynthesis` for reading Claude's responses aloud
- `SpeechRecognition` for voice-to-text input
- Neither available in mini programs; this validates the migration direction

---

## 7. Routing Setup (react-router hash mode)

### Route Table

```typescript
// src/main.tsx
import { createHashRouter, RouterProvider } from "react-router-dom";
import { createRoot } from "react-dom/client";
import App from "./app";
import ProxySelect from "./pages/proxy-select";
import SessionList from "./pages/session-list";
import Chat from "./pages/chat";

const router = createHashRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <ProxySelect /> },
      { path: "pages/proxy-select", element: <ProxySelect /> },
      { path: "pages/session-list", element: <SessionList /> },
      { path: "pages/chat", element: <Chat /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <RouterProvider router={router} />
);
```

### URL Structure Mapping

| Taro URL | Hash URL | Behavior |
|----------|----------|----------|
| `/pages/proxy-select/index` | `/#/pages/proxy-select` | Proxy selection |
| `/pages/session-list/index` | `/#/pages/session-list` | Session list |
| `/pages/chat/index?sessionId=x&mode=pty` | `/#/pages/chat?sessionId=x&mode=pty` | Chat with params |
| `/` (root) | `/#/` | Redirects to proxy-select |

### App Shell Component

`app.tsx` becomes the shell that wraps all pages:
- Providers (AppProvider, SessionProvider, etc.)
- WebSocket initialization
- `<Outlet />` for nested route rendering
- Toast and Modal containers

### Navigation Helper

```typescript
// Convert Taro-style URLs to web hash paths
function toWebPath(taroUrl: string): string {
  return taroUrl.replace(/\/index(\?|$)/, "$1");
}
// "/pages/chat/index?sessionId=abc" -> "/pages/chat?sessionId=abc"
```

---

## 8. Relay Static File Serving

### Express.static Configuration

```typescript
// In apps/relay/src/server.ts, add after existing routes

const webDistDir = process.env.WEB_DIST_DIR
  || path.resolve(__dirname, "../../web/dist");

// Serve the web SPA static assets
if (fs.existsSync(webDistDir)) {
  app.use(express.static(webDistDir, {
    maxAge: "7d",
    etag: true,
  }));

  // SPA fallback: hash routing means the server only sees / and static assets
  // This fallback handles direct access to non-root paths (safety net)
  app.get("*", (req, res, next) => {
    // Skip WebSocket upgrade paths and API routes
    if (req.path === "/proxy" || req.path === "/client" || req.path.startsWith("/health")) {
      return next();
    }
    res.sendFile(path.join(webDistDir, "index.html"));
  });
}
```

### WEB_DIST_DIR Environment Variable

| Scenario | Value | Notes |
|----------|-------|-------|
| Development | Not set, Vite dev server on :5175 | Relay doesn't serve static files |
| Production (Docker) | `/app/web-dist` | Copied during Docker build |
| Local testing | `../../web/dist` (default) | Relative to relay dist |

### Font Serving

Already exists in relay server -- `/fonts` route with CORS headers and 30-day cache. No changes needed.

### Security Headers

No additional CORS configuration needed for same-origin static serving. The existing CORS on `/fonts` handles cross-origin font loading.

---

## 9. Responsive Design Breakpoints

### Three-Tier Breakpoints

| Tier | Width Range | Tailwind Prefix | Layout |
|------|------------|----------------|--------|
| Mobile | <768px | (default) | Current feishu layout: single column, bottom input bar, full-width bubbles |
| Tablet | 768px - 1024px | `md:` | Side panel possible for session list, wider bubbles |
| Desktop | >1024px | `lg:` | Multi-column layout, sidebar navigation, wider content area |

### Per-Breakpoint Layout Differences

**Mobile (<768px):**
- Single column, full-width
- Bottom-anchored input bar
- Bubble max-width: 95%
- Page horizontal padding: 16px
- Matches current feishu mini program behavior exactly

**Tablet (768px - 1024px):**
- Single column with wider margins
- Bubble max-width: 85-90%
- Page horizontal padding: 24px
- Session list could show as side panel (future enhancement)

**Desktop (>1024px):**
- Wider content area, centered
- Bubble max-width: 75-80%
- Page horizontal padding: 32px
- Potential for persistent sidebar with session list

### Tailwind Responsive Usage

```tsx
// Example: bubble max-width responsive
<div className="max-w-[95%] md:max-w-[85%] lg:max-w-[75%]">
  {/* bubble content */}
</div>
```

### CSS Variable Mapping

The existing `screen-portrait`, `screen-landscape`, `screen-desktop` CSS classes with CSS variable overrides map naturally to Tailwind breakpoints:

| Current CSS Class | Tailwind Equivalent |
|------------------|-------------------|
| `.screen-portrait` (default) | Default styles (no prefix) |
| `.screen-landscape` (>500px) | `sm:` or custom breakpoint |
| `.screen-desktop` (>860px) | `md:` or `lg:` |

**Strategy:** Initial migration targets mobile-first (matching current feishu behavior). The `useScreenSize` hook will still classify viewport size, but CSS will use Tailwind responsive prefixes instead of JavaScript-driven class toggling.

---

## 10. Phased Execution Plan

### Phase A: Scaffold apps/web

**Goal:** Empty Vite + React + TypeScript + Tailwind + PWA project that builds and runs.

| Item | Details |
|------|---------|
| Files | `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/app.tsx` (minimal), `src/app.css` |
| Dependencies | ~12 packages (see Dependencies section) |
| Estimated effort | 1-2 hours |
| Dependencies on prior phases | None |
| Verification | `pnpm dev` starts, `pnpm build` produces dist/ |

### Phase B: Copy clean files

**Goal:** All COPY-category files are in apps/web/src, path aliases resolve.

| Item | Details |
|------|---------|
| Files | 26+ files from COPY inventory |
| Estimated effort | 30 minutes |
| Dependencies on prior phases | Phase A (tsconfig paths must resolve) |
| Verification | `pnpm typecheck` passes for copied files |

### Phase C: Migrate services layer

**Goal:** WebSocket, stores, and hooks working with web APIs.

| Item | Details |
|------|---------|
| Files | `websocket.ts`, `app-store.ts`, `terminal-store.ts`, `use-screen-size.ts` |
| Changes | Strip Taro codepaths, replace with localStorage/window APIs |
| Estimated effort | 2-3 hours |
| Dependencies on prior phases | Phase B (relay-client.ts must exist) |
| Verification | `pnpm typecheck` passes, unit tests pass |

### Phase D: Migrate components

**Goal:** All component .tsx files render with HTML elements.

| Item | Details |
|------|---------|
| Files | 18 component directories |
| Changes | Mechanical `View`->`div`, `Text`->`span`, `ScrollView`->`div overflow-auto`, `Input`->`input`, `RichText`->dangerouslySetInnerHTML |
| Estimated effort | 4-6 hours |
| Dependencies on prior phases | Phase C (stores must be adapted) |
| Verification | Components compile, no Taro imports remain |

### Phase E: Migrate pages + app shell + routing

**Goal:** App runs end-to-end with hash routing, navigation works.

| Item | Details |
|------|---------|
| Files | `app.tsx`, `main.tsx`, `routes.tsx`, 3 page components |
| Changes | react-router integration, nav object rewrite, visibilitychange hook, route params |
| Estimated effort | 4-6 hours |
| Dependencies on prior phases | Phase D (components must render) |
| Verification | App loads in browser, navigation between pages works, WebSocket connects |

### Phase F: CSS to Tailwind conversion

**Goal:** All visual styling migrated from CSS files to Tailwind utility classes.

| Item | Details |
|------|---------|
| Files | 22 CSS files, 2784 lines total |
| Changes | Convert 750-scale values, replace with Tailwind utilities, migrate dark theme |
| Estimated effort | 8-12 hours (largest phase) |
| Dependencies on prior phases | Phase E (pages must be functional for visual verification) |
| Verification | Visual parity with feishu H5 build, no remaining component CSS files |

### Phase G: Tests

**Goal:** All unit tests pass, E2E tests work against web build.

| Item | Details |
|------|---------|
| Files | 13 test files, Playwright config |
| Changes | Remove Taro mocks, adapt test for localStorage, update Playwright config for Vite |
| Estimated effort | 2-3 hours |
| Dependencies on prior phases | Phase F (full app must be functional) |
| Verification | `pnpm test` passes, `pnpm exec playwright test` passes |

### Phase H: Relay integration

**Goal:** Relay serves built web SPA, single Docker container deployment works.

| Item | Details |
|------|---------|
| Files | `apps/relay/src/server.ts`, `Dockerfile` update, build scripts |
| Changes | express.static() config, WEB_DIST_DIR env var, Docker multi-stage build |
| Estimated effort | 2-3 hours |
| Dependencies on prior phases | Phase F (must have a buildable dist/) |
| Verification | `pnpm build` produces dist/, relay serves it, WebSocket + SPA on same port |

### Phase I: PWA polish

**Goal:** Installable PWA with proper icons, offline shell, wake lock.

| Item | Details |
|------|---------|
| Files | PWA icons, manifest tuning, service worker config |
| Changes | Generate icons, test install flow, add wake lock hook |
| Estimated effort | 1-2 hours |
| Dependencies on prior phases | Phase H (needs deployed build) |
| Verification | Chrome "Install" prompt appears, offline shell loads, lighthouse PWA audit passes |

### Execution Summary

| Phase | Est. Files | Est. Effort | Depends On |
|-------|-----------|-------------|------------|
| A: Scaffold | ~8 | 1-2h | - |
| B: Copy clean | ~26 | 30min | A |
| C: Services | ~4 | 2-3h | B |
| D: Components | ~18 | 4-6h | C |
| E: Pages + routing | ~6 | 4-6h | D |
| F: CSS to Tailwind | ~22 | 8-12h | E |
| G: Tests | ~13 | 2-3h | F |
| H: Relay integration | ~3 | 2-3h | F |
| I: PWA polish | ~4 | 1-2h | H |
| **Total** | **~104** | **25-38h** | |

Phases G, H, and I can be parallelized after Phase F completes.

---

## 11. Deployment Flexibility

### Scenario 1: Local Development

Vite dev server on `:5175` with proxy to relay on `:3100`.

```typescript
// vite.config.ts
server: {
  port: 5175,
  proxy: {
    "/client": { target: "ws://localhost:3100", ws: true },
    "/proxy": { target: "ws://localhost:3100", ws: true },
    "/fonts": { target: "http://localhost:3100" },
    "/health": { target: "http://localhost:3100" },
  },
}
```

**Workflow:** `pnpm --filter web dev` + `pnpm --filter relay dev` running separately. HMR on `:5175`, WebSocket proxied to relay.

### Scenario 2: Cloud Relay (Primary Use Case)

Single process serves both WebSocket and SPA static files on one port.

```
User's Computer A ─── proxy ──┐
User's Computer B ─── proxy ──┤
                               ├── Cloud Relay (:3100)
Phone/Tablet ── browser SPA ──┘     ├── WebSocket /proxy, /client
                                    ├── Static files /index.html, /assets/*
                                    └── Fonts /fonts/*
```

- Docker container runs relay with `WEB_DIST_DIR=/app/web-dist`
- Single port, single domain, no CORS issues
- WSS via Nginx TLS termination or cloud load balancer
- User accesses `https://relay.example.com/` in mobile browser

### Scenario 3: Tunnel / Local-Only (Budget Users)

For users who don't want to run a cloud server.

```
User's Computer ─── proxy + relay (localhost:3100)
                         ├── ngrok/cloudflare tunnel
Phone ── browser ────────┘
```

- Relay runs locally alongside proxy
- Tunnel service (ngrok, cloudflare tunnel) exposes `:3100` publicly
- Same static serving as cloud scenario
- Relay `WEB_DIST_DIR` points to local web build

### Relay Express.static Configuration (Production)

```typescript
import path from "node:path";
import fs from "node:fs";

const webDistDir = process.env.WEB_DIST_DIR
  || path.resolve(__dirname, "../../web/dist");

if (fs.existsSync(webDistDir)) {
  // Static assets with long cache (hashed filenames from Vite)
  app.use(express.static(webDistDir, {
    maxAge: "7d",
    etag: true,
    index: "index.html",
  }));

  // SPA fallback for direct URL access
  app.get("*", (req, res, next) => {
    if (req.path === "/proxy" || req.path === "/client"
      || req.path.startsWith("/health") || req.path.startsWith("/fonts")) {
      return next();
    }
    res.sendFile(path.join(webDistDir, "index.html"));
  });
}
```

### Docker Multi-Stage Build

```dockerfile
# Stage 1: Build web
FROM node:20-alpine AS web-build
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter web build

# Stage 2: Build relay
FROM node:20-alpine AS relay-build
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter relay build

# Stage 3: Runtime
FROM node:20-alpine
WORKDIR /app
COPY --from=relay-build /app/apps/relay/dist ./relay
COPY --from=web-build /app/apps/web/dist ./web-dist
ENV WEB_DIST_DIR=/app/web-dist
EXPOSE 3100
CMD ["node", "relay/index.js"]
```

---

## Risks and Pitfalls

### Pitfall 1: Input Event Shape

**Issue:** Taro `<Input>` fires `onInput` with `e.detail.value`. Standard `<input>` uses `e.target.value`.
**Affected files:** `input-bar/index.tsx`, `directory-picker/index.tsx`
**Mitigation:** Search-replace all `e.detail.value` -> `e.target.value` in input handlers. Also change `onInput` -> `onChange` where appropriate.

### Pitfall 2: ScrollView onScroll Event Differences

**Issue:** Taro ScrollView `onScroll` provides `e.detail.scrollTop`. Standard div scroll uses `e.currentTarget.scrollTop`.
**Affected files:** `chat-bubble-list/index.tsx`
**Mitigation:** Existing implementation already uses `ref.current.scrollTop` via addEventListener in some places. Verify each ScrollView usage.

### Pitfall 3: 750-Scale CSS Values at 2x

**Issue:** CSS values from 750-design-width that aren't converted will render at 2x intended size (72px buttons become huge).
**Affected files:** All component CSS files (not app.css)
**Mitigation:** Systematic audit: any value that seems unusually large (>40px for font-size, >60px for buttons) is 750-scale. Divide by 2.

### Pitfall 4: `.taro_page` CSS Class

**Issue:** Taro injects `.taro_page` as page wrapper. Standard React won't have this class. app.css has `.taro_page { background: #1a1a2e !important; }`.
**Mitigation:** Remove `.taro_page` rules. Apply equivalent styles to `#root` or `body` in app.css / index.html.

### Pitfall 5: WebSocket Reconnection in PWA Background

**Issue:** When PWA goes to background, WebSocket disconnects. On return, app may not reconnect.
**Affected files:** `app.tsx`
**Mitigation:** The existing `Taro.useDidShow` reconnection logic maps to `visibilitychange` event:
```typescript
useEffect(() => {
  const handler = () => {
    if (document.visibilityState === "visible" && ws && !ws.isConnected()) {
      ws.connect(url);
    }
  };
  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}, []);
```

### Pitfall 6: Vite HMR WebSocket vs App WebSocket

**Issue:** Both Vite HMR and the app use WebSocket, possible confusion.
**Mitigation:** No actual conflict. Vite HMR uses `/@vite/client` path. App WebSocket uses `/client` path, proxied to relay. Vite proxy config handles the separation.

### Pitfall 7: RELAY_URL Define Constant

**Issue:** Existing code uses `declare const RELAY_URL: string` with Taro's `defineConstants`. Vite uses `define` which requires `JSON.stringify`.
**Mitigation:** In `vite.config.ts`, use `define: { RELAY_URL: JSON.stringify(process.env.RELAY_URL || "ws://localhost:3100/client") }`. The existing `declare const RELAY_URL` declaration in code works unchanged.

### Pitfall 8: `IS_H5` Environment Check in websocket.ts

**Issue:** `const IS_H5 = process.env.TARO_ENV === "h5"` will be `undefined` in Vite, causing the Taro codepath to be used.
**Mitigation:** Remove the `IS_H5` branching entirely in the web version. Only keep the native WebSocket path.

---

## Dependencies to Add / Remove

### New Dependencies (apps/web)

**Runtime:**
| Package | Version | Purpose |
|---------|---------|---------|
| `react` | ^18.3.1 | UI framework (keep current version) |
| `react-dom` | ^18.3.1 | DOM renderer |
| `react-router-dom` | ^7.14.1 | Client-side routing with createHashRouter |
| `marked` | ^18.0.0 | Markdown rendering (keep current version) |
| `highlight.js` | ^11.11.1 | Syntax highlighting (keep current version) |

**Dev Dependencies:**
| Package | Version | Purpose |
|---------|---------|---------|
| `vite` | ^6.0.8 | Build tool + dev server |
| `@vitejs/plugin-react` | ^4.5.2 | React fast refresh |
| `tailwindcss` | ^4.2.2 | Utility-first CSS framework |
| `@tailwindcss/vite` | ^4.2.2 | First-party Tailwind Vite plugin |
| `vite-plugin-pwa` | ^1.2.0 | PWA manifest + service worker |
| `@types/react` | ^18.3.28 | React type definitions |
| `@types/react-dom` | ^19.2.3 | ReactDOM type definitions |
| `typescript` | ^5.8.x | TypeScript compiler |
| `vitest` | ^4.1.2 | Testing framework |
| `@playwright/test` | ^1.52.0 | E2E testing |
| `@cc-anywhere/shared` | workspace:* | Shared types and schemas |

### Packages NOT Carried Over (Taro-specific)

| Package | Reason |
|---------|--------|
| `@tarojs/components` | Replaced by HTML elements |
| `@tarojs/helper` | Taro build helper |
| `@tarojs/plugin-framework-react` | Taro React adapter |
| `@tarojs/plugin-platform-h5` | Taro H5 compilation |
| `@tarojs/plugin-platform-lark` | Feishu mini program compilation |
| `@tarojs/react` | Taro React runtime |
| `@tarojs/runtime` | Taro runtime |
| `@tarojs/shared` | Taro shared utilities |
| `@tarojs/taro` | Taro core API |
| `@tarojs/cli` | Taro CLI |
| `@tarojs/webpack5-runner` | Taro webpack builder |
| `@babel/core` | Replaced by Vite (esbuild/SWC) |
| `@babel/preset-react` | Replaced by @vitejs/plugin-react |
| `@babel/runtime` | Babel runtime helper |
| `babel-preset-taro` | Taro babel preset |
| `postcss` | Handled by Tailwind Vite plugin |
| `webpack` | Replaced by Vite |

---

## Assumptions Log

| # | Claim | Risk if Wrong | Mitigation |
|---|-------|---------------|------------|
| A1 | Tailwind v4 `@theme` directive replaces `tailwind.config.js` for custom colors | LOW | Fallback to CSS custom properties which already work |
| A2 | vite-plugin-pwa v1.2.0 is compatible with Vite 6.x | LOW | Widely used combination, downgrade to Vite 5 if needed |
| A3 | react-router-dom v7 `createHashRouter` is stable | LOW | v7 is the current stable release |
| A4 | Tailwind `@tailwindcss/vite` plugin works with Vite 6 | LOW | First-party integration, well-tested |
| A5 | Browser `visibilitychange` event fires reliably on mobile Chrome/Safari | LOW | Standard API, supported since Chrome 33 / Safari 7 |
| A6 | WebSocket reconnection on `visibilitychange` is sufficient for PWA background recovery | MEDIUM | May need additional heartbeat/ping mechanism if OS kills the connection |
