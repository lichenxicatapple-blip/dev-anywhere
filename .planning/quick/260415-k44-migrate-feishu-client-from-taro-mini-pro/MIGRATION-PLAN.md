# CC Anywhere: Feishu Taro to React SPA + PWA Migration Plan

**Created:** 2026-04-15
**Updated:** 2026-04-15 (v3 -- remove artificial limits, trust modern hardware)
**Source:** apps/feishu (Taro 3.6 mini program)
**Target:** apps/web (Vite + React + TypeScript + Tailwind CSS v4 + shadcn/ui + xterm.js + PWA)
**Status:** Draft - Pending review

---

## 1. Architecture Overview

This migration replaces three layers simultaneously:

1. **Framework layer**: Taro mini program -> Vite + React SPA + PWA
2. **Component layer**: Custom UI primitives -> shadcn/ui (Radix UI + Tailwind)
3. **Terminal rendering layer**: Custom TerminalViewport grid renderer -> xterm.js

The xterm.js change is the most impactful: it eliminates the entire server-side terminal parsing pipeline (TerminalTracker, FramePusher, FrameCache, delta compression, anchor scroll) in favor of forwarding raw PTY bytes to the client. This simplifies proxy, relay, AND client simultaneously.

### Before vs After Data Flow

```
BEFORE (current):
  PTY bytes -> TerminalTracker (@xterm/headless, ANSI -> grid) -> FramePusher (diff)
  -> terminal_frame JSON (full/delta) -> relay (FrameCache, merge) -> client
  -> TerminalViewport (grid render, span-by-span)
  Scrollback: scroll_request -> server -> anchor offset -> terminal_frame

AFTER (xterm.js):
  PTY bytes -> ReplayBuffer (growable, raw bytes) -> relay (passthrough)
  -> client -> xterm.js (ANSI parse + render + scrollback, all local)
  Scrollback: xterm.js built-in, zero server involvement
```

---

## 2. New Project Structure

```
apps/web/
  index.html                    # Vite entry HTML (mounts #root)
  vite.config.ts                # Vite + Tailwind + PWA plugin config
  tsconfig.json                 # TypeScript config (extends root)
  package.json
  components.json               # shadcn/ui configuration
  public/
    icons/
      icon-192.png              # PWA icon
      icon-512.png              # PWA icon
  src/
    main.tsx                    # React entry: createHashRouter + RouterProvider
    app.tsx                     # App shell: providers, WebSocket init, Outlet
    app.css                     # @import "tailwindcss" + @theme (design tokens)
    routes.tsx                  # Route table definitions
    lib/
      utils.ts                  # cn() helper for shadcn/ui (clsx + twMerge)
    pages/
      proxy-select/index.tsx
      session-list/index.tsx
      chat/index.tsx
    components/
      ui/                       # shadcn/ui components (generated)
        button.tsx
        dialog.tsx
        scroll-area.tsx
        toast.tsx
        toaster.tsx
        use-toast.ts
      terminal/                 # xterm.js wrapper
        index.tsx               # XTerminal component
        use-terminal.ts         # Hook: xterm lifecycle, fit, write
      assistant-bubble/index.tsx
      chat-bubble-list/index.tsx
      directory-picker/
        index.tsx
        path-utils.ts
      empty-state/index.tsx
      file-path-picker/index.tsx
      input-bar/index.tsx
      markdown-view/index.tsx
      proxy-list-item/index.tsx
      quote-preview-bar/index.tsx
      header/index.tsx          # Renamed from safe-area-header (no safe area in browser)
      session-list-item/index.tsx
      slash-command-picker/index.tsx
      status-line/index.tsx
      tool-approval-card/index.tsx
      tool-call-card/index.tsx
      typewriter/index.tsx
      user-bubble/index.tsx
    hooks/
      use-screen-size.ts        # Rewrite: window.resize, no Taro
    services/
      ensure-binding.ts
      message-parser.ts
      relay-client.ts
      websocket.ts              # Strip Taro codepath, native WebSocket only
    stores/
      app-store.ts              # localStorage instead of Taro storage
      chat-store.ts
      command-store.ts
      file-store.ts
      relay-store.ts
      session-store.ts
      terminal-store.ts         # Rewrite: manages xterm.js instance, no grid/frame state
    utils/
      format-session-name.ts
      relative-time.ts
      summarize-tool-input.ts
      text-truncate.ts
    types/
      stream-json.ts
    phase-machine.ts
    __tests__/
      ...                       # Migrated test files
```

### Config Files

- `vite.config.ts`: Vite + `@tailwindcss/vite` + `@vitejs/plugin-react` + `vite-plugin-pwa`, `@` alias, RELAY_URL define, dev server proxy
- `tsconfig.json`: Extends root, `paths: { "@/*": ["./src/*"] }`, `jsx: "react-jsx"`, `target: "ES2022"`
- `components.json`: shadcn/ui config -- style "new-york", Tailwind CSS v4, `@/components/ui` path, `@/lib/utils` import
- `index.html`: Minimal HTML with `<div id="root">`, viewport meta, dark background `#1E1E1E`
- `package.json`: `@cc-anywhere/shared` workspace reference, build/dev/test scripts

---

## 3. Design Tokens

Design tokens are the single source of truth for visual consistency. Defined as Tailwind v4 `@theme` directives in `app.css`, they replace all CSS variables and hardcoded values from the Taro codebase.

### Token Definitions (app.css)

```css
@import "tailwindcss";

@theme {
  /* Color: Semantic */
  --color-primary: #1890FF;
  --color-accent: #00D4AA;
  --color-success: #52C41A;
  --color-warning: #FAAD14;
  --color-error: #FF4D4F;
  --color-working: #1890FF;
  --color-terminated: #999999;

  /* Color: Surface */
  --color-surface: #1E1E1E;
  --color-surface-secondary: #252526;
  --color-surface-elevated: #2D2D30;
  --color-page-bg: #1A1A2E;

  /* Color: Text */
  --color-text-primary: #D4D4D4;
  --color-text-secondary: #808080;
  --color-text-muted: #5A5A5A;

  /* Color: Border */
  --color-border: #3C3C3C;
  --color-border-light: #2D2D30;

  /* Spacing (matching current CSS variables) */
  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 16px;
  --spacing-lg: 24px;
  --spacing-xl: 32px;

  /* Typography */
  --font-mono: "Sarasa Fixed SC", "SF Mono", "Fira Code", "Cascadia Code", monospace;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;

  /* Border radius */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-full: 9999px;
}
```

### Token Source Mapping

| Token | Current Source | Value | Notes |
|-------|--------------|-------|-------|
| `--color-surface` | `--color-terminal-bg` in app.css | `#1E1E1E` | Was only terminal bg, now primary surface |
| `--color-page-bg` | `body { background: #1a1a2e }` in app.css | `#1A1A2E` | Page background |
| `--color-accent` | New (from CONTEXT.md decision) | `#00D4AA` | shadcn/ui theme accent |
| `--color-text-primary` | `#D4D4D4` in terminal-viewport spans | `#D4D4D4` | Default text on dark bg |
| `--color-text-secondary` | `--color-text-secondary` in app.css | `#999999` -> `#808080` | Adjusted for dark bg contrast |
| `--font-mono` | terminal-viewport CSS `font-family` | Sarasa Fixed SC chain | CJK mono font |

### Responsive Layout Tokens

Replace current CSS variable overrides (`.screen-landscape`, `.screen-desktop`) with Tailwind responsive prefixes:

| Current CSS Class | Tailwind | Bubble Max Width | Page Padding |
|------------------|----------|-----------------|--------------|
| `.screen-portrait` (default) | (default) | 95% | 16px |
| `.screen-landscape` (>=500px) | `sm:` | 85-90% | 24px |
| `.screen-desktop` (>=860px) | `md:` | 75-80% | 32px |

### shadcn/ui Theme Integration

shadcn/ui uses CSS variables for theming. The `components.json` will be configured to use our design tokens:

```json
{
  "style": "new-york",
  "tailwind": {
    "config": "",
    "css": "src/app.css",
    "baseColor": "zinc",
    "cssVariables": true
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui"
  }
}
```

shadcn/ui's default dark theme (zinc palette) maps well to our `#1E1E1E` surface / `#D4D4D4` text scheme. We override the accent/primary HSL variables to match `--color-accent: #00D4AA` and `--color-primary: #1890FF`.

---

## 4. Component Migration Map

Each current component maps to one of: shadcn/ui component, native HTML, xterm.js, or custom (migrated with review). No component is blindly copied.

### Replaced by shadcn/ui

| Current Component | shadcn/ui Replacement | Notes |
|------------------|----------------------|-------|
| `components/toast/` | `shadcn/toast` + `Toaster` | Replace custom DOM-based toast. Use `useToast()` hook. |
| `components/modal/` | `shadcn/dialog` (AlertDialog) | Replace custom Portal-based modal. Radix provides focus trap, ESC dismiss. |
| `components/back-to-bottom/` | `shadcn/button` variant | Simple floating button, use Button with custom styling |
| Various `<button>` elements | `shadcn/button` | Consistent button styling across all components |
| `ScrollView` usages | `shadcn/scroll-area` or native `overflow-auto` | Evaluate per component |

### Replaced by xterm.js

| Current Component | Replacement | Notes |
|------------------|-------------|-------|
| `components/terminal-viewport/` | `components/terminal/XTerminal` | Entire grid renderer removed. xterm.js handles ANSI parse, render, scroll. |
| `components/back-to-bottom/` (in terminal context) | xterm.js scroll API | `terminal.scrollToBottom()` |

### Migrated as Custom (with review)

Every file below gets reviewed for: dead code, naming improvements, type tightening, tech debt cleanup. NOT blind copy.

| Component | Migration Type | Review Focus |
|-----------|---------------|-------------|
| `assistant-bubble/` | Taro -> HTML + Tailwind | View->div, Text->span, CSS->Tailwind |
| `chat-bubble-list/` | Taro -> HTML + Tailwind + ScrollArea | ScrollView replacement, scroll anchoring via native `overflow-anchor` |
| `directory-picker/` | Taro -> HTML + Tailwind + Dialog | Use Dialog for overlay, Input->input |
| `empty-state/` | Taro -> HTML + Tailwind | Simple, View->div |
| `file-path-picker/` | Taro -> HTML + Tailwind | ScrollView->overflow-auto |
| `input-bar/` | Taro -> HTML + Tailwind | Input->input, `e.detail.value`->`e.target.value` |
| `markdown-view/` | Taro -> HTML + Tailwind | RichText->dangerouslySetInnerHTML (browser safe) |
| `proxy-list-item/` | Taro -> HTML + Tailwind | View->div |
| `quote-preview-bar/` | Taro -> HTML + Tailwind | View->div, Text->span |
| `safe-area-header/` -> `header/` | Rewrite | No safe area insets in browser. Use `navigate(-1)` from react-router. Rename. |
| `session-list-item/` | Taro -> HTML + Tailwind | CommonEventFunction->React events, swipe gesture review |
| `slash-command-picker/` | Taro -> HTML + Tailwind | ScrollView->overflow-auto |
| `status-line/` | Taro -> HTML + Tailwind | View->div |
| `tool-approval-card/` | Taro -> HTML + Tailwind + Button | Use shadcn Button for approve/deny |
| `tool-call-card/` | Taro -> HTML + Tailwind | View->div, collapsible card |
| `typewriter/` | Taro -> HTML + Tailwind | View->div, cursor animation |
| `user-bubble/` | Taro -> HTML + Tailwind | View->div, Text->span |

### Deleted (no web equivalent)

| File | Reason |
|------|--------|
| `app.config.ts` | Taro app config, replaced by react-router |
| `pages/*/index.config.ts` | Taro page config, no equivalent needed |
| `components/terminal-viewport/` | Replaced entirely by xterm.js |
| `components/terminal-viewport/index.css` | Replaced by xterm.js built-in styles |

### Taro API to Web API Quick Reference

| Taro API | Web Equivalent | Notes |
|----------|---------------|-------|
| `Taro.navigateTo({ url })` | `navigate(path)` | react-router `useNavigate()` |
| `Taro.reLaunch({ url })` | `navigate(path, { replace: true })` | |
| `Taro.navigateBack()` | `navigate(-1)` | |
| `Taro.getStorageSync(key)` | `localStorage.getItem(key) \|\| ""` | Returns null, not "" |
| `Taro.setStorageSync(key, val)` | `localStorage.setItem(key, val)` | JSON.stringify for non-string |
| `Taro.removeStorageSync(key)` | `localStorage.removeItem(key)` | |
| `Taro.getCurrentPages()` | `window.location.hash` / `useLocation()` | |
| `Taro.useDidShow()` | `useEffect` + `visibilitychange` | |
| `useRouter()` | `useParams()` + `useSearchParams()` | |
| `Taro.onWindowResize` | `window.addEventListener("resize", ...)` | |
| `Taro.getSystemInfoSync()` | `window.innerWidth/Height` | |
| `Taro.connectSocket()` | `new WebSocket(url)` | Already has native path |

### Navigation

react-router's `useNavigate()` is sufficient. No wrapper needed. The `toWebPath()` conversion for Taro-style URLs (`/pages/chat/index?x=1` -> `/pages/chat?x=1`) is a one-line utility used only in the `nav` object for `phase-machine.ts`.

---

## 5. xterm.js Integration (Detailed Design)

This is the most impactful change. It touches all three tiers: proxy, relay, and client.

### 5.1 What Gets Deleted

| Package | File | Lines | What It Does |
|---------|------|-------|-------------|
| proxy | `terminal-tracker.ts` | ~180 | @xterm/headless to parse PTY output into TermLine[] grid |
| proxy | `frame-pusher.ts` | ~120 | Diff engine: compare grids, emit full/delta terminal_frame JSON |
| proxy | `frame-cache.ts` | ~60 | Merge delta frames into cached full grid for reconnection |
| proxy | `terminal-frame-renderer.ts` | ~100 | ANSI renderer for replay tool |
| relay | FrameCache usage in `handlers/proxy.ts` | ~30 | Server-side frame caching and merge |
| shared | `TerminalFramePayloadSchema` (full/delta) | ~40 | Grid-based frame schema |
| shared | `TermSpanSchema`, `CursorSchema` | ~15 | Grid cell types |
| feishu | `terminal-viewport/` | ~200 | Custom grid renderer with touch/pinch/wheel handlers |
| feishu | `terminal-store.ts` (grid parts) | ~80 | Grid state, font size, scroll offset management |
| **Total** | | **~825** | Entire server-side terminal parsing pipeline |

### 5.2 What Gets Added

**Client side (`apps/web`):**

```
components/terminal/
  index.tsx           # XTerminal React component
  use-terminal.ts     # Hook: create Terminal, attach FitAddon, handle resize
```

Dependencies:
- `@xterm/xterm` - Terminal emulator core
- `@xterm/addon-fit` - Auto-resize terminal to container
- `@xterm/addon-web-links` - Clickable links in terminal output
- `@xterm/addon-unicode11` - Unicode width detection (CJK characters)

```tsx
// XTerminal component
function XTerminal({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const ws = useRelayClient();

  useEffect(() => {
    const term = new Terminal({
      theme: {
        background: '#1E1E1E',
        foreground: '#D4D4D4',
        cursor: '#D4D4D4',
      },
      fontFamily: 'Sarasa Fixed SC, SF Mono, monospace',
      fontSize: 14,
      scrollback: 10000,  // user-configurable, generous default
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current!);
    fit.fit();
    termRef.current = term;

    // Write incoming PTY bytes
    const unsubscribe = ws.onPtyData(sessionId, (data: Uint8Array) => {
      term.write(data);
    });

    return () => { unsubscribe(); term.dispose(); };
  }, [sessionId]);

  return <div ref={containerRef} className="w-full h-full" />;
}
```

**Proxy side (`apps/proxy`):**

The proxy changes from "parse then push frames" to "buffer raw bytes and forward":

```typescript
// Growable replay buffer replacing TerminalTracker + FramePusher.
// No fixed size limit. A terminal session's full output is tens of MB at most.
// Proxy runs on a developer machine with plenty of memory.
class ReplayBuffer {
  private chunks: Uint8Array[] = [];
  private totalBytes = 0;

  write(data: Uint8Array): void {
    this.chunks.push(data);
    this.totalBytes += data.length;
  }

  // For reconnection: replay ALL buffered data. Never truncate.
  getAll(): Uint8Array {
    const result = new Uint8Array(this.totalBytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }
}
```

The PTY data flow becomes:
1. `node-pty` emits data
2. Data written to ReplayBuffer (for reconnection)
3. Data forwarded to relay as binary WebSocket frame
4. (OSC title extraction continues as before -- it reads the raw stream)

**Relay side (`apps/relay`):**

Relay becomes a binary passthrough for PTY data:
- New message type: `pty_data` (binary frame, sessionId header)
- Relay does NOT parse or cache the content
- Relay broadcasts to all clients bound to the proxy
- The existing JSON control messages (session_create, tool_approve, etc.) remain unchanged

### 5.3 Protocol Changes

**New binary frame format (proxy -> relay -> client):**

```
[1 byte: message type = 0x01 for pty_data]
[2 bytes: sessionId length (uint16 BE)]
[N bytes: sessionId (UTF-8)]
[remaining bytes: raw PTY data]
```

Or simpler: use a JSON envelope with base64-encoded data for the initial implementation, optimize to binary frames later if needed:

```json
{
  "type": "pty_data",
  "sessionId": "abc123",
  "data": "<base64 encoded PTY bytes>"
}
```

**Removed message types:**
- `terminal_frame` (full/delta grid JSON)
- `terminal_frame_request` (client asking for current grid)
- `terminal_scroll_request` (server-side scroll)

**Kept message types (unchanged):**
- `terminal_title` (OSC title extraction, still useful)
- `terminal_resize` (cols/rows notification)
- `pty_state` (semantic state: idle, working, etc.)
- All chat/tool/session messages

### 5.4 Exception Handling Design

#### Reconnection: Scrollback Recovery

**Problem:** Client disconnects and reconnects. xterm.js instance is fresh, scrollback is empty.

**Solution:** Proxy maintains a ReplayBuffer (growable array of raw PTY byte chunks). On reconnection, proxy sends the full buffer content. xterm.js replays it, rebuilding the visible state and scrollback.

The natural limit is xterm.js's scrollback setting (default 10000 lines, user-configurable). Even if the ReplayBuffer contains more data than xterm.js's scrollback can hold, xterm.js simply discards lines beyond its scrollback limit during replay. The data is complete on the wire; the client-side display limit is the user's choice.

**Reconnection sequence:**
1. Client connects, sends session bind request
2. Relay forwards bind to proxy
3. Proxy sends the full ReplayBuffer content as one or more `pty_data` messages
4. Proxy then switches to live forwarding
5. Use a sequence counter to prevent duplicate data at the switchover point

#### Multi-Client Viewing Same Session

**Problem:** Multiple clients (phone + tablet + desktop) watching the same PTY session.

**Solution:** Relay broadcasts every `pty_data` frame to ALL clients bound to that proxy+session. Each client's xterm.js processes the bytes independently. This is simpler than the current approach (single cached grid frame).

**Late joiner:** Gets the ReplayBuffer dump first, then switches to live. Other clients are unaffected.

#### UTF-8 / ANSI Truncation at Frame Boundaries

**Problem:** PTY emits bytes in arbitrary chunks. A UTF-8 multi-byte character or ANSI escape sequence might be split across two chunks.

**Solution:** xterm.js handles this natively. Its parser maintains state across `write()` calls. Partial UTF-8 sequences are buffered internally until complete. This is one of the key advantages over the custom TerminalTracker -- no special handling needed on proxy or relay side. Forward raw bytes as-is.

#### High-Speed Output

**Problem:** `cat large-file.txt` or compilation output floods the terminal.

**Solution:** xterm.js has built-in write batching -- it coalesces rapid `write()` calls and batches DOM updates internally using requestAnimationFrame. Write speed is not 1:1 with render speed. Trust xterm.js to handle this; it's the same engine VS Code uses.

No proxy-side throttling or output sampling. Forward everything. The client-side rendering engine handles its own pace.

#### Binary Data Encoding

**Decision:** Start with base64 over JSON text frames for simplicity and debugging. Migrate to binary WebSocket frames if profiling shows encoding overhead matters.

- JSON+base64: ~33% overhead, but trivially debuggable, works with existing JSON message routing
- Binary frames: zero overhead, but requires separate routing path in relay

For the initial migration, JSON+base64 is correct. The overhead is negligible at terminal output rates (typically <10KB/s, burst <1MB/s). Optimization to binary frames can be a follow-up task.

#### Backpressure: Slow Client

**Problem:** Fast PTY output + slow mobile network = data accumulates in relay's send buffer.

**Solution:** WebSocket already has TCP-level flow control. If a client's network is slow, the OS TCP send buffer fills, and the WebSocket library handles this. The relay should monitor `ws.readyState` and disconnect truly dead clients (no heartbeat response). Do not silently drop data or pause forwarding based on `bufferedAmount` thresholds -- the user expects complete output.

If a client disconnects under load, it reconnects and gets the full ReplayBuffer. No data is lost.

### 5.5 terminal-store.ts Rewrite

The current `terminal-store.ts` manages:
- Grid state (lines, cursor) -- **DELETE** (xterm.js manages this)
- Font size index and persistence -- **KEEP** (user preference)
- Scroll offset and anchor -- **DELETE** (xterm.js manages scrollback)
- Frame application (full/delta merge) -- **DELETE**

New `terminal-store.ts` responsibilities:
- Font size preference (persisted to localStorage)
- xterm.js Terminal instance reference per session
- Terminal theme/config derived from design tokens

---

## 6. CSS Migration Strategy

### Approach

All CSS files are converted to Tailwind utility classes during component migration. No separate "CSS conversion phase" -- each component's CSS is converted as part of its migration.

**Design-width conversion:** Taro 750px design width -> divide by 2 for real px -> map to Tailwind utilities.

| 750-scale px | Real px | Tailwind | Usage |
|-------------|---------|---------|-------|
| 28px | 14px | `text-sm` | Body text |
| 32px | 16px | `text-base`, `p-4` | Base text, padding |
| 36px | 18px | `rounded-2xl` | Border radius |
| 72px | 36px | `w-9 h-9` | Button size |

**app.css special case:** Uses real pixel values (not 750-scale). CSS variables migrate directly to `@theme` tokens. Keyframe animations (`pulse`, `breathing`, `sweepRight`, `bubbleEntranceLeft`, `bubbleEntranceRight`) kept as custom CSS alongside `@import "tailwindcss"`.

### Dark Mode

The app is dark-themed by default. Set `<html class="dark">`. Design tokens define dark-theme colors as the baseline. No `dark:` prefix needed for the default state. Light mode is a future enhancement.

Replace current `.chat-page-dark .component { ... }` pattern with direct dark-first Tailwind classes.

---

## 7. Routing Setup

### Route Table

```typescript
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
```

### URL Mapping

| Taro URL | Hash URL |
|----------|----------|
| `/pages/proxy-select/index` | `/#/pages/proxy-select` |
| `/pages/session-list/index` | `/#/pages/session-list` |
| `/pages/chat/index?sessionId=x&mode=pty` | `/#/pages/chat?sessionId=x&mode=pty` |

### Nav Object for phase-machine.ts

```typescript
const nav = {
  reLaunch: (url: string) => navigate(toWebPath(url), { replace: true }),
  navigateTo: (url: string) => navigate(toWebPath(url)),
  showToast: (title: string) => toast({ description: title }),  // shadcn toast
  getStorageSync: (key: string) => localStorage.getItem(key) || "",
  removeStorageSync: (key: string) => localStorage.removeItem(key),
  getCurrentPath: () => window.location.hash.replace(/^#/, ""),
};
```

`phase-machine.ts` requires zero changes.

---

## 8. PWA Configuration

### manifest (via vite-plugin-pwa)

```typescript
VitePWA({
  registerType: "autoUpdate",
  manifest: {
    name: "CC Anywhere",
    short_name: "CC Anywhere",
    theme_color: "#1E1E1E",
    background_color: "#1A1A2E",
    display: "standalone",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
  },
  workbox: {
    runtimeCaching: [
      {
        urlPattern: /\.(?:js|css|woff2?)$/,
        handler: "CacheFirst",
        options: { cacheName: "static-assets", expiration: { maxAgeSeconds: 30 * 24 * 60 * 60 } },
      },
    ],
    navigateFallback: "index.html",
  },
})
```

### Future PWA Capabilities

- **Screen Wake Lock API:** Keep screen awake during active sessions
- **Web Speech API:** Voice readback + voice input
- Neither available in mini programs; this validates the migration direction

---

## 9. Relay Static File Serving

### Express.static Configuration

```typescript
const webDistDir = process.env.WEB_DIST_DIR
  || path.resolve(__dirname, "../../web/dist");

if (fs.existsSync(webDistDir)) {
  app.use(express.static(webDistDir, { maxAge: "7d", etag: true }));

  // SPA fallback (hash routing means this rarely fires)
  app.get("*", (req, res, next) => {
    if (req.path === "/proxy" || req.path === "/client"
      || req.path.startsWith("/health") || req.path.startsWith("/fonts")) {
      return next();
    }
    res.sendFile(path.join(webDistDir, "index.html"));
  });
}
```

---

## 10. Deployment

### Primary: Cloud Relay

Multiple computers -> one cloud relay -> mobile browser.

```
Computer A -- proxy --> Cloud Relay (:3100) <-- browser (phone/tablet)
Computer B -- proxy -->     |
                            +-- WebSocket /proxy, /client
                            +-- Static files /index.html, /assets/*
                            +-- Fonts /fonts/*
```

Single Docker container, single port, single domain. WSS via Nginx TLS termination or cloud load balancer.

### Budget: Local Relay + Tunnel

For users who don't want a cloud server.

```
Computer -- proxy + relay (localhost:3100)
                  |
                  +-- Tailscale / Cloudflare Tunnel
                  |
Phone -- browser --+
```

Same static serving, exposed via tunnel. Zero cloud cost.

### Docker Multi-Stage Build

```dockerfile
FROM node:20-alpine AS web-build
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter web build

FROM node:20-alpine AS relay-build
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter relay build

FROM node:20-alpine
WORKDIR /app
COPY --from=relay-build /app/apps/relay/dist ./relay
COPY --from=web-build /app/apps/web/dist ./web-dist
ENV WEB_DIST_DIR=/app/web-dist
EXPOSE 3100
CMD ["node", "relay/index.js"]
```

---

## 11. Phased Execution Plan

The xterm.js change affects all three tiers. The phases reflect this cross-cutting scope.

### Phase A: Project Scaffold + Design Tokens

**Goal:** Empty Vite + React + Tailwind + shadcn/ui project that builds. Design tokens defined.

| Item | Details |
|------|---------|
| Create | `apps/web/` with package.json, vite.config.ts, tsconfig.json, index.html |
| Configure | Tailwind v4, shadcn/ui (Button, Dialog, ScrollArea, Toast), design tokens in app.css |
| Setup | `cn()` utility, path aliases, RELAY_URL define |
| Verify | `pnpm dev` starts, `pnpm build` produces dist/, shadcn Button renders with correct theme |
| Effort | 2-3 hours |

### Phase B: Review and Migrate Business Logic

**Goal:** All pure logic files reviewed and migrated. No Taro dependency files yet.

| Item | Details |
|------|---------|
| Review | Each of the 26 "zero Taro dependency" files for dead code, naming, type improvements |
| Migrate | `phase-machine.ts`, stores (chat, command, file, relay, session), services (ensure-binding, message-parser, relay-client), utils, types |
| Adapt | `app-store.ts` (localStorage), `websocket.ts` (strip Taro codepath) |
| Rewrite | `use-screen-size.ts` (window.resize, no Taro APIs) |
| Verify | `pnpm typecheck` passes, unit tests pass |
| Effort | 3-4 hours |

### Phase C: xterm.js Integration (Client)

**Goal:** xterm.js terminal component working, fed by mock data or direct WebSocket.

| Item | Details |
|------|---------|
| Create | `components/terminal/index.tsx`, `components/terminal/use-terminal.ts` |
| Install | `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`, `@xterm/addon-unicode11` |
| Rewrite | `terminal-store.ts` to manage xterm.js instance instead of grid state |
| Test | Feed xterm.js with recorded PTY data, verify rendering |
| Verify | Terminal renders ANSI output correctly, scrollback works, resize works |
| Effort | 3-4 hours |

### Phase D: xterm.js Integration (Proxy + Relay)

**Goal:** Proxy forwards raw PTY bytes, relay passes through, client renders via xterm.js.

| Item | Details |
|------|---------|
| Proxy | Add ReplayBuffer (growable, no size limit), forward raw PTY data instead of frame-pushing |
| Proxy | Keep OSC title extraction (reads raw stream) |
| Relay | Add `pty_data` passthrough routing (broadcast to bound clients) |
| Protocol | Add `pty_data` message type to shared schemas |
| Wire | End-to-end: PTY -> proxy -> relay -> client xterm.js |
| Verify | Live terminal output visible in browser, scrollback works, reconnection replays full buffer |
| Effort | 6-8 hours |
| **Risk** | Highest risk phase. Touches all three tiers. Must be tested end-to-end. |

### Phase E: Migrate Pages and Components

**Goal:** All pages render with HTML + Tailwind + shadcn/ui. App navigates end-to-end.

| Item | Details |
|------|---------|
| Pages | `proxy-select`, `session-list`, `chat` -- Taro components -> HTML + Tailwind |
| App Shell | `app.tsx` with providers, WebSocket init, react-router `<Outlet />` |
| Components | All 17 custom components migrated (see Component Migration Map) |
| Replace | Toast -> shadcn Toast, Modal -> shadcn Dialog, buttons -> shadcn Button |
| CSS | Convert inline CSS and CSS files to Tailwind utilities during migration |
| Verify | All pages load, navigation works, WebSocket connects, chat functional |
| Effort | 10-14 hours (largest phase) |

### Phase F: Proxy + Relay Cleanup

**Goal:** Delete obsolete server-side terminal parsing code.

| Item | Details |
|------|---------|
| Delete proxy | `terminal-tracker.ts`, `frame-pusher.ts`, `frame-cache.ts`, `terminal-frame-renderer.ts` |
| Delete proxy | Related tests: `frame-pusher.test.ts`, `frame-cache.test.ts`, `terminal-data-flow.test.ts` |
| Clean relay | Remove FrameCache usage, remove `terminal_frame` routing |
| Clean shared | Remove `TerminalFramePayloadSchema` if no longer referenced |
| Update | `replay.ts` to use raw byte replay instead of frame replay |
| Verify | Proxy builds, relay builds, existing tests pass (minus deleted ones) |
| Effort | 3-4 hours |

### Phase G: Tests + Relay Integration

**Goal:** All tests pass, relay serves built web SPA.

| Item | Details |
|------|---------|
| Tests | Migrate test files, remove Taro mocks, add xterm.js integration tests |
| Relay | `express.static()` config, `WEB_DIST_DIR` env var |
| E2E | Playwright tests against web build |
| Docker | Update Dockerfile for multi-stage build |
| Verify | `pnpm test` passes, `pnpm exec playwright test` passes, relay serves SPA |
| Effort | 4-5 hours |

### Phase H: PWA Polish

**Goal:** Installable PWA with proper icons, offline shell.

| Item | Details |
|------|---------|
| Icons | Generate 192x192 and 512x512 PNG icons |
| Manifest | Tune vite-plugin-pwa config |
| Wake Lock | Add Screen Wake Lock hook (acquire on active session) |
| Verify | Chrome "Install" prompt, offline shell loads, Lighthouse PWA audit |
| Effort | 1-2 hours |

### Execution Summary

| Phase | Scope | Est. Effort | Depends On |
|-------|-------|-------------|------------|
| A: Scaffold + Tokens | apps/web setup | 2-3h | - |
| B: Business Logic | Review + migrate 26+ files | 3-4h | A |
| C: xterm.js Client | Terminal component | 3-4h | A |
| D: xterm.js Proxy+Relay | Binary passthrough pipeline | 6-8h | C |
| E: Pages + Components | UI migration | 10-14h | B, D |
| F: Server Cleanup | Delete old terminal code | 3-4h | D, E |
| G: Tests + Integration | Testing + relay serving | 4-5h | E, F |
| H: PWA Polish | Icons, offline, wake lock | 1-2h | G |
| **Total** | | **33-44h** | |

```
Phase A --+-- Phase B ----------+
          |                     |
          +-- Phase C -- Phase D --+
                                   +-- Phase E -- Phase F -- Phase G -- Phase H
```

Phases B and C can run in parallel after A. Phase D depends only on C. Phase E requires both B and D. This is the critical path.

---

## 12. Dependencies

### New Dependencies (apps/web)

**Runtime:**
| Package | Version | Purpose |
|---------|---------|---------|
| `react` | ^18.3.1 | UI framework |
| `react-dom` | ^18.3.1 | DOM renderer |
| `react-router-dom` | ^7.14.1 | Client-side routing (HashRouter) |
| `marked` | ^18.0.0 | Markdown rendering |
| `highlight.js` | ^11.11.1 | Syntax highlighting |
| `@xterm/xterm` | ^5.x | Terminal emulator |
| `@xterm/addon-fit` | ^0.10.x | Terminal auto-resize |
| `@xterm/addon-web-links` | ^0.11.x | Clickable links |
| `@xterm/addon-unicode11` | ^0.8.x | CJK character width |
| `clsx` | ^2.x | Conditional className utility (for shadcn cn()) |
| `tailwind-merge` | ^2.x | Tailwind class dedup (for shadcn cn()) |
| `class-variance-authority` | ^0.7.x | Component variants (shadcn dependency) |

**Dev Dependencies:**
| Package | Version | Purpose |
|---------|---------|---------|
| `vite` | ^6.0.8 | Build tool + dev server |
| `@vitejs/plugin-react` | ^4.5.2 | React fast refresh |
| `tailwindcss` | ^4.2.2 | CSS framework |
| `@tailwindcss/vite` | ^4.2.2 | Tailwind Vite plugin |
| `vite-plugin-pwa` | ^1.2.0 | PWA support |
| `@types/react` | ^18.x | Type definitions |
| `@types/react-dom` | ^19.x | Type definitions |
| `typescript` | ^5.8.x | Compiler |

**shadcn/ui components (source-copied, not npm packages):**
- Button, Dialog (AlertDialog), ScrollArea, Toast + Toaster

### Packages Dropped (Taro-specific)

All `@tarojs/*`, `babel-preset-taro`, `webpack`, `@babel/*`, `postcss` (handled by Tailwind Vite plugin).

---

## 13. Risks and Pitfalls

### Risk 1: xterm.js Mobile Performance

**Concern:** xterm.js is designed for desktop. On low-end mobile devices, rendering high-speed output (compilation, `cat` large file) might stutter.

**Mitigation:** xterm.js is used in VS Code which runs on Chromebooks and other constrained devices. xterm.js batches DOM updates internally via requestAnimationFrame. Profile early in Phase C with real mobile devices.

### Risk 2: Input Event Shape (`e.detail.value` -> `e.target.value`)

**Affected files:** `input-bar/index.tsx`, `directory-picker/index.tsx`

**Mitigation:** Mechanical search-replace. Caught at compile time since the types differ.

### Risk 3: WebSocket Reconnection in PWA Background

**Concern:** PWA goes to background, WebSocket dies, app must reconnect on return.

**Mitigation:** `visibilitychange` event triggers reconnection. ReplayBuffer on proxy side means the reconnecting client gets the full session history replayed by xterm.js.

### Risk 4: Binary Frame Encoding Overhead

**Concern:** base64 encoding adds 33% overhead to PTY data.

**Mitigation:** Terminal output is typically <10KB/s. Even at burst rates of 1MB/s, base64 overhead is negligible. Optimize to binary frames only if profiling justifies it.

---

## 14. Assumptions Log

| # | Claim | Risk | Mitigation |
|---|-------|------|------------|
| A1 | xterm.js handles split UTF-8/ANSI across write() calls | LOW | Documented behavior, used by VS Code |
| A2 | xterm.js mobile rendering is adequate for terminal output rates | MEDIUM | Profile in Phase C |
| A3 | Tailwind v4 `@theme` works with shadcn/ui CSS variables | LOW | Both use CSS custom properties |
| A4 | base64 encoding overhead is negligible at terminal rates | LOW | Can migrate to binary frames later |
| A5 | shadcn/ui components work with Tailwind v4 | LOW | shadcn docs list v4 as supported |
