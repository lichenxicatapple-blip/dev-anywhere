# Quick Task 260415-k44: Migrate Feishu Client from Taro to React SPA + PWA - Research

**Researched:** 2026-04-15
**Domain:** Taro mini program to standard React SPA migration
**Confidence:** HIGH

## Summary

The migration from `apps/feishu` (Taro 3.6 mini program) to `apps/web` (pure React SPA + PWA) is mechanically straightforward. The existing codebase already uses React hooks, context-based state management, and standard CSS -- Taro is a thin wrapper, not deeply entangled. The WebSocket layer already has a native browser codepath (H5 mode), and the CSS uses real px values (not Taro's 750-design-width pxtransform in most files -- the `app.css` already uses actual pixel values, only `input-bar/index.css` and similar component CSS files use 750-scale values like `72px` for buttons that render as `36px`).

**Primary recommendation:** Scaffold `apps/web` with Vite + React + TypeScript + Tailwind CSS v4 + react-router-dom v7 (HashRouter). Copy business logic files verbatim. Mechanically replace Taro components/APIs. Convert CSS to Tailwind utilities. Add PWA via vite-plugin-pwa. Serve from relay via express.static().

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- monorepo `apps/web`, `apps/feishu` archived
- Tailwind CSS, replacing Taro pxtransform
- Responsive breakpoints: mobile(<768px) / tablet(768-1024px) / desktop(>1024px)
- Dark theme via Tailwind `dark:` prefix
- Relay serves static files, single process for WebSocket + frontend
- Hash routing, no server-side routing
- Vite dev server + WebSocket proxy during development
- PWA: Screen Wake Lock API, Web Speech API (future)

### Specific Ideas (from user)
- Taro components -> HTML: View->div, Text->span, ScrollView->div overflow, Image->img
- Business logic (stores, services, message-parser, relay-store) zero-change reuse
- Browser native overflow-anchor for scroll anchoring
- Browser native element.scrollIntoView() for auto-scroll
- marked + highlight.js continue, dangerouslySetInnerHTML now usable
- react-router hash mode
</user_constraints>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `vite` | ^6.0.8 | Build tool + dev server | [VERIFIED: npm registry] Standard for React SPA in 2026 |
| `@vitejs/plugin-react` | ^4.5.2 | React fast refresh for Vite | [VERIFIED: npm registry] Official Vite React plugin |
| `react` | ^18.3.1 | UI framework | Already in use, keep version |
| `react-dom` | ^18.3.1 | DOM renderer | Already in use |
| `react-router-dom` | ^7.14.1 | Client-side routing (HashRouter) | [VERIFIED: npm registry] v7 stable, createHashRouter API |
| `tailwindcss` | ^4.2.2 | Utility-first CSS | [VERIFIED: npm registry] v4 with native Vite plugin |
| `@tailwindcss/vite` | ^4.2.2 | Tailwind Vite integration | [VERIFIED: npm registry] First-party, zero-config |
| `vite-plugin-pwa` | ^1.2.0 | PWA manifest + service worker | [VERIFIED: npm registry] Uses Workbox under the hood |
| `marked` | ^18.0.0 | Markdown rendering | Already in use, keep |
| `highlight.js` | ^11.11.1 | Syntax highlighting | Already in use, keep |

### Keep from existing
| Library | Why |
|---------|-----|
| `@cc-anywhere/shared` | Shared types/schemas, workspace reference |
| `vitest` | Testing framework, already configured in monorepo |
| `@playwright/test` | E2E tests, already configured |

### Drop (Taro-specific)
All `@tarojs/*` packages, `babel-preset-taro`, `webpack`, `@babel/*` (Vite uses esbuild/SWC).

**Installation:**
```bash
cd apps/web
pnpm add react react-dom react-router-dom marked highlight.js
pnpm add -D vite @vitejs/plugin-react tailwindcss @tailwindcss/vite vite-plugin-pwa @types/react @types/react-dom vitest @playwright/test typescript
```

## Architecture Patterns

### Project Structure
```
apps/web/
  index.html              # Vite entry HTML
  vite.config.ts          # Vite + Tailwind + PWA config
  tsconfig.json
  public/
    icons/                # PWA icons (192x192, 512x512)
  src/
    main.tsx              # React entry, router setup
    app.tsx               # App shell (providers, WebSocket init)
    app.css               # Global styles + @import "tailwindcss"
    routes.tsx            # Route definitions
    pages/                # Page components (from feishu/pages)
    components/           # UI components (from feishu/components)
    hooks/                # Custom hooks (migrated from feishu)
    services/             # relay-client, websocket, message-parser
    stores/               # Context-based state (from feishu/stores)
    utils/                # Utility functions (from feishu/utils)
    types/                # Type definitions
    __tests__/            # Tests (from feishu/__tests__)
```

### Pattern 1: Vite + Tailwind CSS v4 Setup [CITED: tailwindcss.com/docs]

Tailwind v4 uses CSS-first configuration. No `tailwind.config.js` needed.

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "CC Anywhere",
        short_name: "CC Anywhere",
        theme_color: "#1A1A2E",
        background_color: "#1A1A2E",
        display: "standalone",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
      workbox: {
        // Network-first for API/WebSocket, cache-first for static assets
        runtimeCaching: [
          {
            urlPattern: /\.(?:js|css|woff2?)$/,
            handler: "CacheFirst",
            options: { cacheName: "static-assets", expiration: { maxEntries: 100, maxAgeSeconds: 30 * 24 * 60 * 60 } },
          },
        ],
        // Don't cache WebSocket or API endpoints
        navigateFallback: "index.html",
      },
    }),
  ],
  resolve: {
    alias: { "@": "/src" },
  },
  define: {
    RELAY_URL: JSON.stringify(process.env.RELAY_URL || "ws://localhost:3100/client"),
  },
  server: {
    port: 5175,
    proxy: {
      "/client": { target: "ws://localhost:3100", ws: true },
      "/fonts": { target: "http://localhost:3100" },
    },
  },
});
```

```css
/* src/app.css */
@import "tailwindcss";

/* Custom theme via CSS variables -- Tailwind v4 uses @theme directive */
@theme {
  --color-primary: #1890FF;
  --color-surface: #FFFFFF;
  --color-surface-secondary: #F5F5F5;
  --color-terminal-bg: #1E1E1E;
  --color-text-primary: #333333;
  --color-text-secondary: #999999;
  --color-border: #E8E8E8;
}
```

### Pattern 2: Hash Router Setup [CITED: reactrouter.com/api/data-routers/createHashRouter]

```typescript
// src/main.tsx
import { createHashRouter, RouterProvider } from "react-router-dom";
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

### Pattern 3: Relay Serving Static Files

The relay already uses Express and serves fonts via express.static(). Add SPA serving with the same pattern.

```typescript
// In apps/relay/src/server.ts -- add after existing routes
const webDistDir = process.env.WEB_DIST_DIR || path.resolve(__dirname, "../../web/dist");

// Serve static assets from the web build
app.use(express.static(webDistDir, { maxAge: "7d" }));

// SPA fallback: return index.html for all non-API, non-WebSocket routes
// Hash routing means this rarely fires, but it's a safety net
app.get("*", (req, res) => {
  res.sendFile(path.join(webDistDir, "index.html"));
});
```

Note: With hash routing (`/#/pages/chat`), the server only ever sees requests for `/` and static assets. The SPA fallback is a safety net, not a requirement.

## Taro to Web Migration Map

### Component Replacements

| Taro Component | Web Equivalent | Notes |
|---------------|---------------|-------|
| `<View>` | `<div>` | Direct replacement |
| `<Text>` | `<span>` | Direct replacement |
| `<ScrollView>` | `<div style="overflow:auto">` | Need manual scroll event binding |
| `<RichText nodes={...}>` | `<div dangerouslySetInnerHTML={{__html: ...}}>` | Now safe in browser context |
| `<Input>` | `<input>` | Event shape differs (see pitfalls) |
| `<Image>` | `<img>` | Direct replacement |

### API Replacements

| Taro API | Web Equivalent | Files Affected |
|----------|---------------|----------------|
| `Taro.navigateTo({ url })` | `navigate(path)` from react-router | app.tsx, pages/* |
| `Taro.reLaunch({ url })` | `navigate(path, { replace: true })` | app.tsx, chat/index.tsx |
| `Taro.navigateBack()` | `navigate(-1)` | safe-area-header, chat |
| `Taro.getStorageSync(key)` | `localStorage.getItem(key)` | app-store, terminal-store, app.tsx, pages/* |
| `Taro.setStorageSync(key, val)` | `localStorage.setItem(key, val)` | app-store, pages/* |
| `Taro.removeStorageSync(key)` | `localStorage.removeItem(key)` | app-store, chat |
| `Taro.getCurrentPages()` | `window.location.hash` or `useLocation()` | app.tsx (getCurrentPath) |
| `Taro.useDidShow()` | `useEffect` + `document.visibilitychange` | app.tsx |
| `useRouter()` | `useParams()` + `useSearchParams()` | chat/index.tsx |
| `usePullDownRefresh()` | Custom pull-to-refresh or button | proxy-select |
| `Taro.onWindowResize` | `window.addEventListener("resize", ...)` | use-screen-size.ts |
| `Taro.getSystemInfoSync()` | `window.innerWidth/Height` | use-screen-size.ts |
| `Taro.connectSocket()` | `new WebSocket(url)` | websocket.ts (already has native path!) |
| `Taro.getApp().tt?.setWindowSize()` | Remove (Feishu desktop-specific) | chat/index.tsx |
| `Taro.stopPullDownRefresh()` | Remove (no native pull-down) | proxy-select |
| `CommonEventFunction` type | `React.TouchEvent / React.MouseEvent` | session-list-item |

### WebSocket Manager Simplification

The `websocket.ts` already has a native WebSocket codepath (`IS_H5` branch using `createNativeTask`). For the web version, strip the Taro codepath entirely and use the native path only. The `TaskLike` abstraction can be simplified to direct `WebSocket` usage.

### phase-machine.ts Nav Interface

The `nav` object in `app.tsx` abstracts navigation/storage for `phase-machine.ts`. This is a clean seam -- replace the implementation, keep the interface:

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

## CSS Migration Strategy

### Design Width Analysis

The Taro config uses `designWidth: 750` with `pxtransform`. In H5 mode, Taro converts 750-scale px to rem. Examining the actual CSS files:

**`app.css`**: Uses real pixel values (4px, 8px, 16px, etc.) via CSS variables. No conversion needed.

**Component CSS files** (e.g., `input-bar/index.css`): Mix of real values and 750-scale values. The 750-scale values are identifiable by their unusual sizes:
- `72px` (button size) = 36px real
- `36px` (border-radius) = 18px real  
- `28px` (font-size) = 14px real
- `22px` (small font-size) = 11px real
- `32px` (padding) = 16px real

**Conversion formula:** `real_px = taro_px / 2` (because designWidth=750, typical device=375px)

### Migration Approach

Convert all CSS to Tailwind utility classes. The conversion is:
1. Identify 750-scale values (divide by 2 to get real px)
2. Map to nearest Tailwind spacing/sizing utility
3. For custom values, use arbitrary values like `w-[36px]` or define in `@theme`

Common mappings from 750-scale:
| 750-scale px | Real px | Tailwind Class |
|-------------|---------|----------------|
| 16px | 8px | `p-2`, `gap-2` |
| 24px | 12px | `p-3`, `gap-3` |
| 28px | 14px | `text-sm` |
| 32px | 16px | `p-4`, `text-base` |
| 36px | 18px | `rounded-2xl` |
| 72px | 36px | `w-9 h-9` |

### Dark Mode

Replace the current `.chat-page-dark .component { ... }` pattern with Tailwind's `dark:` variant. Set `<html class="dark">` since the app is dark-themed by default.

## PWA Configuration

### Service Worker Strategy [CITED: vite-pwa-org.netlify.app/guide/service-worker-strategies-and-behaviors]

For a real-time WebSocket chat app:
- **Use `generateSW`** (default) -- no custom service worker logic needed
- **Use `registerType: "autoUpdate"`** -- auto-activate new service workers, no user prompt
- **Cache strategy:** CacheFirst for static assets (JS/CSS/fonts), NetworkFirst or no caching for dynamic data
- **Do NOT cache WebSocket connections** -- Workbox only handles HTTP fetch, not WebSocket
- **navigateFallback:** Set to `index.html` for offline SPA shell

### PWA Icon Requirements
- 192x192 PNG (required for Add to Home Screen)
- 512x512 PNG (required for splash screen)
- Optional: maskable icons for Android adaptive icon display

### Screen Wake Lock API [CITED: developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API]

```typescript
// Future feature -- keep screen awake during active sessions
async function requestWakeLock() {
  if ("wakeLock" in navigator) {
    const lock = await navigator.wakeLock.request("screen");
    // Release on visibility change, re-acquire on return
    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState === "visible") {
        await navigator.wakeLock.request("screen");
      }
    });
    return lock;
  }
}
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Service worker generation | Custom SW registration | vite-plugin-pwa + Workbox | Handles precache manifest, updates, fallback |
| CSS utility system | Custom CSS framework | Tailwind CSS v4 | Responsive, dark mode, consistent spacing |
| Client-side routing | Custom hash parser | react-router-dom v7 HashRouter | Handles params, navigation, nested routes |
| Pull-to-refresh | Custom touch gesture | Remove or use a simple "Refresh" button | PWA handles app updates; pull-to-refresh was for Taro page lifecycle |

## Common Pitfalls

### Pitfall 1: Taro Input Event Shape vs Standard HTML
**What goes wrong:** Taro `<Input>` fires `onInput` with `e.detail.value`. Standard `<input>` uses `e.target.value`.
**How to avoid:** Search-replace all `e.detail.value` to `e.target.value` in input handlers.

### Pitfall 2: ScrollView onScroll Event Differences
**What goes wrong:** Taro ScrollView's `onScroll` provides `e.detail.scrollTop`. Standard div scroll uses `e.currentTarget.scrollTop`.
**How to avoid:** The existing `chat-bubble-list` already uses `ref.current.scrollTop` via addEventListener (not Taro's event). Verify each ScrollView usage.

### Pitfall 3: Taro pxtransform Residual Values
**What goes wrong:** 750-scale CSS values that weren't Tailwind-ified render at 2x intended size.
**How to avoid:** Audit every CSS file. Any value that seems unusually large (>40px for font-size, >60px for buttons) is likely a 750-scale value. Divide by 2.

### Pitfall 4: CSS Class `.taro_page` in app.css
**What goes wrong:** Taro injects `.taro_page` as page wrapper. Standard React won't have this class.
**How to avoid:** Remove `.taro_page` rules. Apply equivalent styles to the root `#root` or `body` element.

### Pitfall 5: WebSocket Reconnection in PWA Background
**What goes wrong:** When a PWA goes to background (phone screen off, app switch), WebSocket disconnects. On return, the app may not reconnect.
**How to avoid:** The existing `Taro.useDidShow` reconnection logic maps to `visibilitychange` event. Implement reconnection on `document.visibilityState === "visible"`.

### Pitfall 6: Vite Dev Server WebSocket Proxy
**What goes wrong:** Vite's HMR WebSocket conflicts with the app's WebSocket to relay.
**How to avoid:** Configure Vite proxy for `/client` path to relay server. Vite HMR uses a separate WebSocket on a different path (`/@vite/client`), so no actual conflict as long as the app's WebSocket URL is proxied correctly.

### Pitfall 7: RELAY_URL Define Constant
**What goes wrong:** The existing code uses `declare const RELAY_URL: string` with Taro's `defineConstants`. Vite uses `define` which requires JSON.stringify.
**How to avoid:** In `vite.config.ts`, use `define: { RELAY_URL: JSON.stringify("ws://...") }`. The existing `declare const RELAY_URL` in code works unchanged.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Tailwind v4 `@theme` directive replaces tailwind.config.js for custom colors | CSS Migration | LOW -- fallback to CSS custom properties which already work |
| A2 | vite-plugin-pwa v1.2.0 is compatible with Vite 6.x | Standard Stack | LOW -- widely used combination, but not verified in this session |

## Sources

### Primary (HIGH confidence)
- npm registry -- verified versions for all recommended packages
- Existing codebase -- analyzed all 60+ source files in apps/feishu/src

### Secondary (MEDIUM confidence)
- [Tailwind CSS v4 Vite installation](https://tailwindcss.com/docs) -- setup pattern
- [react-router createHashRouter API](https://reactrouter.com/api/data-routers/createHashRouter) -- routing pattern
- [vite-plugin-pwa guide](https://vite-pwa-org.netlify.app/guide/) -- PWA configuration
- [Screen Wake Lock API MDN](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API) -- future feature reference
