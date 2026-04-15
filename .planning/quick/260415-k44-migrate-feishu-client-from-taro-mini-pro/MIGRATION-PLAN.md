# CC Anywhere: Feishu Taro to React SPA + PWA Migration Plan

**Created:** 2026-04-15
**Updated:** 2026-04-15 (v4 -- persistent snapshots, binary frames, no artificial limits)
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
  PTY bytes -> EventStore (binary persistence to disk) + @xterm/headless (periodic snapshots)
  -> binary WebSocket frame -> relay (binary passthrough) -> client -> xterm.js
  Scrollback: xterm.js built-in, zero server involvement
  Reconnection: latest snapshot + events since snapshot from disk
  Proxy restart: restore from disk, resume where left off
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
      websocket.ts              # Strip Taro codepath, native WebSocket only, binary frame support
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

Defined as Tailwind v4 `@theme` directives in `app.css`. Single source of truth for visual consistency.

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

shadcn/ui's default dark theme (zinc palette) maps well to our `#1E1E1E` surface / `#D4D4D4` text scheme. Override accent/primary HSL variables to match `--color-accent: #00D4AA` and `--color-primary: #1890FF`.

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

Every file gets reviewed for: dead code, naming improvements, type tightening, tech debt cleanup.

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

react-router's `useNavigate()` is sufficient. No wrapper needed. Change the URL strings directly in `phase-machine.ts`: `/pages/chat/index` -> `/chat`, `/pages/session-list/index` -> `/session-list`, etc.

---

## 5. xterm.js Integration (Detailed Design)

This is the most impactful change. It touches all three tiers: proxy, relay, and client.

### 5.1 What Gets Deleted

| Package | File | Lines | What It Does |
|---------|------|-------|-------------|
| proxy | `terminal-tracker.ts` (current version) | ~180 | @xterm/headless to parse PTY output into TermLine[] grid |
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
      scrollback: 10000,  // user-configurable
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current!);
    fit.fit();
    termRef.current = term;

    // Write incoming PTY bytes (binary frames)
    const unsubscribe = ws.onPtyData(sessionId, (data: Uint8Array) => {
      term.write(data);
    });

    return () => { unsubscribe(); term.dispose(); };
  }, [sessionId]);

  return <div ref={containerRef} className="w-full h-full" />;
}
```

**Proxy side (`apps/proxy`) -- EventStore + TerminalTracker:**

Restore the design from commit b05bec2 with improvements. The proxy persists all PTY data and snapshots to disk.

```typescript
// EventStore (restored from b05bec2): binary format, gzip support, disk persistence
// Binary format: CCAE header + length-prefixed records
// Event types: PTY_OUTPUT (1), SNAPSHOT (2), PTY_INPUT (3)
// 1-second buffer window for batching writes to disk
// Supports gzip archival of completed sessions
class EventStore {
  // append(type, payload) -- buffered write, auto-flush every 1s
  // flush() -- immediate write to disk
  // writeSnapshot(payload) -- bypasses buffer, writes directly
  // readEvents(afterSeq) -- read events from disk (archive + active file)
  // getLatestSnapshot() -- find most recent SNAPSHOT event
  // archive() -- gzip the active file for long-term storage
}
```

```typescript
// TerminalTracker (restored from b05bec2): @xterm/headless + serialize addon
// Feeds all PTY data into a headless xterm instance
// Generates serialized snapshots on:
//   - state transition: working -> idle
//   - every 100 events
// Snapshots are both persisted to EventStore and written to snapshot.bin
class TerminalTracker {
  // feed(data) -- write to headless xterm
  // takeSnapshot() -- serialize terminal state, write to EventStore
  // shouldSnapshot() -- true when 100+ events since last snapshot
  // onStateChange(from, to) -- auto-snapshot on working->idle
}
```

The PTY data flow becomes:
1. `node-pty` emits data
2. Data written to EventStore as PTY_OUTPUT event (persisted to disk)
3. Data fed to TerminalTracker's headless xterm (for periodic snapshots)
4. Data forwarded to relay as binary WebSocket frame
5. OSC title extraction continues (reads the raw stream)
6. On proxy restart: EventStore + latest snapshot loaded from disk, session resumes

**Relay side (`apps/relay`):**

Relay becomes a binary passthrough for PTY data:
- Binary WebSocket frames = PTY data (passthrough, no parsing)
- JSON text WebSocket frames = control messages (existing behavior)
- Relay broadcasts binary frames to all clients bound to that proxy+session
- Relay does NOT parse, cache, or modify PTY data

### 5.3 Protocol Changes

**Binary frame format (proxy -> relay -> client):**

PTY data is transmitted as binary WebSocket frames. The relay distinguishes binary vs text frames at the WebSocket protocol level -- no header parsing needed for routing.

```
Binary frame:
  [2 bytes: sessionId length (uint16 BE)]
  [N bytes: sessionId (UTF-8)]
  [remaining bytes: raw PTY data]

Text frame (JSON):
  { "type": "...", ... }  // existing control messages, unchanged
```

The relay routes binary frames by extracting the sessionId prefix and broadcasting to all clients bound to that session. The client strips the sessionId prefix and writes the remaining bytes to xterm.js.

This is a day-one decision. Binary frames avoid the 33% base64 overhead and the encoding/decoding cost on every frame. The routing logic is trivial (2-byte length prefix + sessionId) and the relay already handles different WebSocket message types.

**Removed message types:**
- `terminal_frame` (full/delta grid JSON)
- `terminal_frame_request` (client asking for current grid)
- `terminal_scroll_request` (server-side scroll)

**Kept message types (unchanged):**
- `terminal_title` (OSC title extraction, still useful)
- `terminal_resize` (cols/rows notification)
- `pty_state` (semantic state: idle, working, etc.)
- All chat/tool/session messages

### 5.4 Persistence and Reconnection Design

This is the critical section. All PTY data and snapshots are persisted to disk.

#### Disk Layout (per session)

```
~/.cc-anywhere/data/{sessionId}/
  events.bin       # Active binary event log (CCAE format)
  events.bin.gz    # Archived (gzipped) event log for completed sessions
  snapshot.bin     # Latest serialized xterm state (fast-access copy)
```

#### Snapshot Strategy

The proxy runs @xterm/headless with the serialize addon. Snapshots are taken:
- On every working -> idle state transition (Claude finishes a response)
- Every 100 PTY_OUTPUT events (safety net during long outputs)

A snapshot captures the full xterm terminal state: screen content, scrollback buffer, cursor position, colors, attributes. It can be loaded into any xterm instance (headless or browser) via the serialize addon to reconstruct the exact visual state.

#### Reconnection: Client Reconnects to Running Proxy

1. Client connects, sends session bind request
2. Relay forwards bind to proxy
3. Proxy reads the latest snapshot from EventStore on disk
4. Proxy reads all PTY_OUTPUT events after the snapshot's sequence number
5. Proxy sends: snapshot (as a typed binary frame) + subsequent raw PTY events
6. Client loads snapshot into xterm.js via serialize addon, then writes subsequent events
7. Proxy switches to live forwarding with a sequence counter to prevent duplicates

The client's xterm.js instance is fully reconstructed. Scrollback, colors, cursor position -- everything matches the proxy's headless xterm state.

#### Proxy Restart Recovery

1. Proxy starts, discovers existing session data in `~/.cc-anywhere/data/{sessionId}/`
2. Loads latest snapshot from disk into a new headless xterm instance
3. Replays PTY_OUTPUT events after the snapshot to catch up
4. Resumes normal operation: new PTY output appends to EventStore, snapshots continue
5. When a client connects, the reconnection flow above works unchanged

This is why disk persistence is non-negotiable. Without it, a proxy restart means all terminal history is lost.

#### Session History Playback

The EventStore on disk contains the complete PTY event stream. A replay tool can:
- Read `events.bin` (or `events.bin.gz` for archived sessions)
- Feed events to a headless xterm or browser xterm.js at real-time or accelerated speed
- Jump to any snapshot point and replay forward from there

This enables reviewing past sessions without the proxy running.

#### Multi-Client Viewing

Relay broadcasts every binary frame to ALL clients bound to that proxy+session. Each client's xterm.js processes the bytes independently. Late joiners get the snapshot + catchup flow. Other clients are unaffected.

#### UTF-8 / ANSI Truncation at Frame Boundaries

xterm.js handles this natively. Its parser maintains state across `write()` calls. Partial UTF-8 sequences are buffered internally until complete. Forward raw bytes as-is, no special handling needed.

#### High-Speed Output

xterm.js has built-in write batching via requestAnimationFrame. It coalesces rapid `write()` calls and batches DOM updates. This is the same engine VS Code uses. No proxy-side throttling.

#### Backpressure

WebSocket has TCP-level flow control. If a client's network is slow, the OS TCP send buffer fills and the WebSocket library handles backpressure. The relay monitors `ws.readyState` and disconnects dead clients (no heartbeat response). No data is silently dropped. If a client disconnects under load, it reconnects and gets the full replay.

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
      { path: "proxy-select", element: <ProxySelect /> },
      { path: "session-list", element: <SessionList /> },
      { path: "chat", element: <Chat /> },
    ],
  },
]);
```

### URL Mapping

| Taro URL | Hash URL |
|----------|----------|
| `/pages/proxy-select/index` | `/#/proxy-select` |
| `/pages/session-list/index` | `/#/session-list` |
| `/pages/chat/index?sessionId=x&mode=pty` | `/#/chat?sessionId=x&mode=pty` |

### Nav Object for phase-machine.ts

Change the URL strings directly in `phase-machine.ts`. The Taro-style paths (`/pages/chat/index`) become simple paths (`/chat`). `useNavigate()` handles everything:

```typescript
const nav = {
  reLaunch: (url: string) => navigate(url, { replace: true }),
  navigateTo: (url: string) => navigate(url),
  showToast: (title: string) => toast({ description: title }),  // shadcn toast
  getStorageSync: (key: string) => localStorage.getItem(key) || "",
  removeStorageSync: (key: string) => localStorage.removeItem(key),
  getCurrentPath: () => window.location.hash.replace(/^#/, ""),
};
```

No `toWebPath()` conversion function. The URLs in `phase-machine.ts` are updated to use the new paths directly.

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

### Phase A: Project Scaffold + Design Tokens

**Goal:** Empty Vite + React + Tailwind + shadcn/ui project that builds. Design tokens defined.

| Item | Details |
|------|---------|
| Create | `apps/web/` with package.json, vite.config.ts, tsconfig.json, index.html |
| Configure | Tailwind v4, shadcn/ui (Button, Dialog, ScrollArea, Toast), design tokens in app.css |
| Setup | `cn()` utility, path aliases, RELAY_URL define |
| Verify | `pnpm dev` starts, `pnpm build` produces dist/, shadcn Button renders with correct theme |

### Phase B: Review and Migrate Business Logic

**Goal:** All pure logic files reviewed and migrated. No Taro dependency files yet.

| Item | Details |
|------|---------|
| Review | Each of the 26 "zero Taro dependency" files for dead code, naming, type improvements |
| Migrate | `phase-machine.ts`, stores (chat, command, file, relay, session), services (ensure-binding, message-parser, relay-client), utils, types |
| Adapt | `app-store.ts` (localStorage), `websocket.ts` (strip Taro codepath, add binary frame handling) |
| Rewrite | `use-screen-size.ts` (window.resize, no Taro APIs) |
| Verify | `pnpm typecheck` passes, unit tests pass |

### Phase C: xterm.js Integration (Client)

**Goal:** xterm.js terminal component working, fed by mock data or direct WebSocket.

| Item | Details |
|------|---------|
| Create | `components/terminal/index.tsx`, `components/terminal/use-terminal.ts` |
| Install | `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`, `@xterm/addon-unicode11`, `@xterm/addon-serialize` |
| Rewrite | `terminal-store.ts` to manage xterm.js instance instead of grid state |
| Test | Feed xterm.js with recorded PTY data, verify rendering |
| Verify | Terminal renders ANSI output correctly, scrollback works, resize works |

### Phase D: Persistence + Binary Pipeline (Proxy + Relay)

**Goal:** Proxy persists PTY data to disk, forwards as binary frames, relay passes through, client renders via xterm.js.

| Item | Details |
|------|---------|
| Proxy | Restore EventStore from b05bec2 (binary format, gzip, disk persistence) |
| Proxy | Restore TerminalTracker (@xterm/headless + serialize addon for periodic snapshots) |
| Proxy | Forward raw PTY data as binary WebSocket frames |
| Proxy | Reconnection handler: send latest snapshot + events since snapshot |
| Relay | Binary frame passthrough routing (binary = PTY, text = JSON control) |
| Relay | Broadcast binary frames to all clients bound to session |
| Protocol | Binary frame format with sessionId prefix (shared schema) |
| Wire | End-to-end: PTY -> EventStore -> binary WS -> relay -> client xterm.js |
| Verify | Live terminal visible in browser, reconnection replays correctly, proxy restart recovers state |
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

### Phase F: Proxy + Relay Cleanup

**Goal:** Delete obsolete server-side terminal parsing code.

| Item | Details |
|------|---------|
| Delete proxy | `frame-pusher.ts`, `frame-cache.ts`, `terminal-frame-renderer.ts` |
| Delete proxy | Related tests: `frame-pusher.test.ts`, `frame-cache.test.ts`, `terminal-data-flow.test.ts` |
| Clean relay | Remove FrameCache usage, remove `terminal_frame` routing |
| Clean shared | Remove `TerminalFramePayloadSchema` if no longer referenced |
| Update | `replay.ts` to use EventStore binary format (read events.bin, feed xterm.js) |
| Verify | Proxy builds, relay builds, existing tests pass (minus deleted ones) |

### Phase G: Tests + Relay Integration

**Goal:** All tests pass, relay serves built web SPA.

| Item | Details |
|------|---------|
| Tests | Migrate test files, remove Taro mocks, add xterm.js integration tests, add EventStore tests (restore from b05bec2) |
| Relay | `express.static()` config, `WEB_DIST_DIR` env var |
| E2E | Playwright tests against web build |
| Docker | Update Dockerfile for multi-stage build |
| Verify | `pnpm test` passes, `pnpm exec playwright test` passes, relay serves SPA |

### Phase H: PWA Polish

**Goal:** Installable PWA with proper icons, offline shell.

| Item | Details |
|------|---------|
| Icons | Generate 192x192 and 512x512 PNG icons |
| Manifest | Tune vite-plugin-pwa config |
| Wake Lock | Add Screen Wake Lock hook (acquire on active session) |
| Verify | Chrome "Install" prompt, offline shell loads, Lighthouse PWA audit |

### Execution Summary

| Phase | Scope | Depends On |
|-------|-------|------------|
| A: Scaffold + Tokens | apps/web setup | - |
| B: Business Logic | Review + migrate 26+ files | A |
| C: xterm.js Client | Terminal component + serialize addon | A |
| D: Persistence + Binary Pipeline | EventStore, snapshots, binary WS, reconnection | C |
| E: Pages + Components | UI migration | B, D |
| F: Server Cleanup | Delete old terminal code | D, E |
| G: Tests + Integration | Testing + relay serving | E, F |
| H: PWA Polish | Icons, offline, wake lock | G |

```
Phase A --+-- Phase B ----------+
          |                     |
          +-- Phase C -- Phase D --+
                                   +-- Phase E -- Phase F -- Phase G -- Phase H
```

Phases B and C can run in parallel after A. Phase D depends only on C. Phase E requires both B and D.

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
| `@xterm/addon-serialize` | ^0.13.x | Snapshot deserialization (load snapshot into browser xterm) |
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

**Proxy additional dependencies (for restored EventStore + TerminalTracker):**
| Package | Version | Purpose |
|---------|---------|---------|
| `@xterm/headless` | ^5.x | Headless terminal for snapshot generation (already in proxy) |
| `@xterm/addon-serialize` | ^0.13.x | Serialize terminal state for snapshots (already in proxy) |

**shadcn/ui components (source-copied, not npm packages):**
- Button, Dialog (AlertDialog), ScrollArea, Toast + Toaster

### Packages Dropped (Taro-specific)

All `@tarojs/*`, `babel-preset-taro`, `webpack`, `@babel/*`, `postcss` (handled by Tailwind Vite plugin).

---

## 13. Pitfalls

### Pitfall 1: Input Event Shape (`e.detail.value` -> `e.target.value`)

**Affected files:** `input-bar/index.tsx`, `directory-picker/index.tsx`

**Mitigation:** Mechanical search-replace. Caught at compile time since the types differ.

### Pitfall 2: WebSocket Reconnection in PWA Background

PWA goes to background, WebSocket dies. `visibilitychange` event triggers reconnection. Proxy sends snapshot + catchup events from disk. Full state restored.

### Pitfall 3: Taro pxtransform Residual Values

750-scale CSS values render at 2x intended size if not converted. Any CSS value >40px for font-size or >60px for buttons is likely 750-scale. Divide by 2.

### Pitfall 4: CSS Class `.taro_page`

Taro injects `.taro_page` as page wrapper. Remove these rules. Apply equivalent styles to `#root` or `body`.

### Pitfall 5: RELAY_URL Define Constant

Taro uses `defineConstants`, Vite uses `define` with `JSON.stringify`. The existing `declare const RELAY_URL` in code works unchanged.

---

## 14. Assumptions Log

| # | Claim | Risk | Mitigation |
|---|-------|------|------------|
| A1 | xterm.js handles split UTF-8/ANSI across write() calls | LOW | Documented behavior, used by VS Code |
| A2 | Tailwind v4 `@theme` works with shadcn/ui CSS variables | LOW | Both use CSS custom properties |
| A3 | shadcn/ui components work with Tailwind v4 | LOW | shadcn docs list v4 as supported |
| A4 | @xterm/addon-serialize can load snapshots generated by @xterm/headless | LOW | Same addon used in both environments, documented API |
| A5 | Binary WebSocket frames pass through standard reverse proxies (Nginx, Cloudflare) | LOW | Binary WS is part of the RFC 6455 standard |
