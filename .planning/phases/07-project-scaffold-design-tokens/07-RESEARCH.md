# Phase 7: Project Scaffold + Design Tokens - Research

**Researched:** 2026-04-15
**Domain:** Vite + React + Tailwind CSS v4 + shadcn/ui project scaffolding, design token system
**Confidence:** HIGH

## Summary

Phase 7 creates `apps/web` -- a new Vite + React 19 + TypeScript + Tailwind CSS v4 + shadcn/ui project in the existing pnpm monorepo. The core work is: (1) scaffold the project with correct monorepo integration, (2) define a comprehensive dark-theme design token system via Tailwind v4 `@theme` directive aligned with shadcn/ui CSS variable conventions, (3) configure Vite dev server proxy for WebSocket (`/client`, `/proxy`) and fonts (`/fonts`) to relay at `localhost:3100`, (4) render a Token Showcase page validating all tokens visually.

Tailwind CSS v4 represents a major architectural shift: configuration moves from JavaScript (`tailwind.config.js`) to CSS-first (`@theme` directive). Design tokens are declared as CSS variables inside `@theme {}` blocks, and Tailwind generates corresponding utility classes automatically. shadcn/ui already supports Tailwind v4 natively via `@theme inline` mapping of its semantic CSS variables.

**Primary recommendation:** Use `pnpm create vite` with React + TypeScript template, install Tailwind v4 via `@tailwindcss/vite` plugin, run `shadcn init` for component infrastructure, then define all design tokens in a single `app.css` using `@theme` + `:root` CSS variables following shadcn/ui's semantic naming convention.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Three anchor colors: #1E1E1E surface, #D4D4D4 text, #00D4AA accent
- **D-02:** VS Code-style multi-level dark surface grays: #1E1E1E page bg, #252526 card, #2D2D2D popover, #3C3C3C input, #404040 border
- **D-03:** Status colors (working/success/warning/error) harmonized with #00D4AA accent and dark theme -- Claude's discretion on specific values
- **D-04:** UI text uses system font stack: `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
- **D-05:** Terminal/code uses Sarasa Fixed SC (cn-font-split subset, ~254 woff2 files from relay `/fonts/`)
- **D-06:** Font CSS loaded via `<link rel="stylesheet" href="/fonts/sarasa-fixed-sc/result.css">` in index.html
- **D-07:** Dev mode: Vite `server.proxy` proxies `/fonts/*` to relay. Production: relay serves both SPA and fonts (same origin)
- **D-08:** Compact tool style: 4px radius, 12px padding, 1px border. VS Code / terminal aesthetic
- **D-09:** shadcn/ui components customized with compact CSS variables (radius, spacing), no default rounded style
- **D-10:** Mobile-first three-tier responsive: Mobile (<640px), Tablet (640-1024px), Desktop (>1024px)
- **D-11:** Use Tailwind v4 default breakpoints (sm:640, md:768, lg:1024), mobile-first progressive enhancement
- **D-12:** Initial page is Token Showcase page displaying color palette, typography, spacing scale, and shadcn/ui Button component

### Claude's Discretion
- Status color specific hex values (must harmonize with dark theme + #00D4AA accent)
- Tailwind v4 @theme token organization structure and naming conventions
- shadcn/ui initial component set (minimum: Button)
- Vite + React + TypeScript project configuration details

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| FRONT-01 | apps/web project scaffolding (Vite + React + TypeScript + Tailwind CSS + shadcn/ui) | Standard Stack section covers all dependencies, versions, and setup steps. Architecture Patterns section covers project structure. |
| FRONT-02 | Design token definition (colors, font sizes, spacing, border-radius) configured in Tailwind theme | Architecture Patterns "Design Token Architecture" subsection covers @theme directive, CSS variable naming, shadcn/ui integration pattern. Code Examples provide complete token definitions. |
| DEPLOY-02 | Vite dev mode WebSocket proxy to relay | Architecture Patterns "Vite Dev Server Proxy" subsection covers proxy configuration for `/client`, `/proxy` WebSocket endpoints and `/fonts` static files to relay at localhost:3100. |
</phase_requirements>

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `vite` | ^8.0.8 | Build tool and dev server | De facto standard for React SPA. Fast HMR, native ESM, Tailwind v4 plugin support. [VERIFIED: npm registry] |
| `@vitejs/plugin-react` | ^6.0.1 | React Fast Refresh for Vite | Official React plugin from Vite team. [VERIFIED: npm registry] |
| `react` | ^19.2.5 | UI framework | Latest stable. shadcn/ui fully supports React 19. New project, no legacy React 18 constraints. [VERIFIED: npm registry] |
| `react-dom` | ^19.2.5 | React DOM renderer | Paired with react. [VERIFIED: npm registry] |
| `tailwindcss` | ^4.2.2 | Utility-first CSS framework | v4 uses CSS-first `@theme` directive for design tokens. Generates CSS variables automatically. [VERIFIED: npm registry] |
| `@tailwindcss/vite` | ^4.2.2 | Tailwind CSS Vite plugin | Replaces PostCSS plugin from v3. Zero-config integration. [VERIFIED: npm registry] |
| `react-router` | ^7.14.1 | Client-side routing | Will be needed in Phase 8 (FRONT-09). Install now for basic structure. [VERIFIED: npm registry] |

### shadcn/ui Dependencies

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `shadcn` | ^4.2.0 | CLI for adding components | Official CLI. Manages component installation and updates. [VERIFIED: npm registry] |
| `tw-animate-css` | ^1.4.0 | Animation utilities | Replaces deprecated `tailwindcss-animate`. Required by shadcn/ui. [VERIFIED: npm registry] |
| `class-variance-authority` | ^0.7.1 | Component variant management | Core dependency for shadcn/ui component variants. [VERIFIED: npm registry] |
| `clsx` | ^2.1.1 | Conditional className construction | Used by shadcn/ui's `cn()` utility. [VERIFIED: npm registry] |
| `tailwind-merge` | ^3.5.0 | Tailwind class deduplication | Used by shadcn/ui's `cn()` utility. [VERIFIED: npm registry] |
| `lucide-react` | ^1.8.0 | Icon library | shadcn/ui's default icon library. [VERIFIED: npm registry] |
| `@radix-ui/react-slot` | ^1.2.4 | Polymorphic component slots | Required by shadcn/ui Button's `asChild` prop. [VERIFIED: npm registry] |

### Dev Dependencies

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@types/node` | ^22.x | Node.js type definitions | Required for Vite config `path.resolve`. [ASSUMED] |
| `@types/react` | ^19.2.14 | React type definitions | TypeScript support. [VERIFIED: npm registry] |
| `@types/react-dom` | ^19.x | React DOM type definitions | TypeScript support. [ASSUMED] |

### Workspace Dependencies

| Package | Source | Purpose |
|---------|--------|---------|
| `@cc-anywhere/shared` | `workspace:*` | Shared schemas, types, builders. Required for relay communication. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| React 19 | React 18 (existing feishu uses 18) | React 19 is recommended for new projects. shadcn/ui v4 components drop `forwardRef` for React 19. No reason to start with 18. |
| Tailwind CSS v4 | Tailwind CSS v3 | v4 is locked decision. CSS-first config is simpler, no tailwind.config.js needed. |
| tw-animate-css | tailwindcss-animate | tailwindcss-animate is deprecated for Tailwind v4. tw-animate-css is the successor. [CITED: ui.shadcn.com/docs/tailwind-v4] |

**Installation:**
```bash
# Create apps/web directory and initialize
cd apps/web
pnpm init

# Core dependencies
pnpm add react react-dom react-router

# Tailwind + shadcn dependencies
pnpm add tailwindcss @tailwindcss/vite tw-animate-css class-variance-authority clsx tailwind-merge lucide-react @radix-ui/react-slot

# Dev dependencies
pnpm add -D vite @vitejs/plugin-react @types/node @types/react @types/react-dom typescript

# Workspace dependency
pnpm add -D @cc-anywhere/shared@workspace:*

# Initialize shadcn/ui (after project structure is in place)
pnpm dlx shadcn@latest init
```

## Architecture Patterns

### Recommended Project Structure

```
apps/web/
├── package.json
├── tsconfig.json              # extends ../../tsconfig.base.json, adds DOM lib + JSX
├── tsconfig.node.json         # for vite.config.ts
├── vite.config.ts             # plugins, proxy, path alias
├── vitest.config.ts           # test configuration
├── components.json            # shadcn/ui configuration
├── index.html                 # entry HTML, font CSS link
├── src/
│   ├── main.tsx               # React root mount
│   ├── app.tsx                # App component (router shell)
│   ├── app.css                # @theme tokens + shadcn CSS variables + @import tailwindcss
│   ├── lib/
│   │   └── utils.ts           # cn() utility (shadcn standard)
│   ├── components/
│   │   └── ui/
│   │       └── button.tsx     # shadcn/ui Button (installed via CLI)
│   └── pages/
│       └── token-showcase.tsx # Token display page (initial page)
└── public/                    # static assets (if any)
```

### Pattern 1: Tailwind v4 CSS-First Design Tokens

**What:** All design tokens defined in CSS using `@theme` directive, no JavaScript config file.
**When to use:** Every Tailwind v4 project. This IS the configuration mechanism.
**Source:** [CITED: tailwindcss.com/docs/theme]

```css
/* app.css */
@import "tailwindcss";
@import "tw-animate-css";

/* shadcn/ui semantic CSS variables -- dark theme only (this app is dark-only) */
:root {
  /* Surface hierarchy (VS Code style gray scale) */
  --background: #1E1E1E;
  --foreground: #D4D4D4;
  --card: #252526;
  --card-foreground: #D4D4D4;
  --popover: #2D2D2D;
  --popover-foreground: #D4D4D4;
  --primary: #00D4AA;
  --primary-foreground: #1E1E1E;
  --secondary: #2D2D2D;
  --secondary-foreground: #D4D4D4;
  --muted: #252526;
  --muted-foreground: #808080;
  --accent: #2D2D2D;
  --accent-foreground: #D4D4D4;
  --destructive: #F44747;
  --border: #404040;
  --input: #3C3C3C;
  --ring: #00D4AA;

  /* Radius -- compact tool style */
  --radius: 0.25rem;

  /* Status colors */
  --color-status-working: #1890FF;
  --color-status-success: #00D4AA;
  --color-status-warning: #E8AB5A;
  --color-status-error: #F44747;
}

/* Map shadcn CSS variables to Tailwind v4 theme */
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
}

/* Custom theme extensions */
@theme {
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: "Sarasa Fixed SC", ui-monospace, SFMono-Regular, Menlo, monospace;
  --radius-sm: calc(var(--radius) - 2px);
  --radius-md: var(--radius);
  --radius-lg: calc(var(--radius) + 2px);
  --radius-xl: calc(var(--radius) + 4px);
}
```

**Key insight:** shadcn/ui uses a two-layer system: (1) semantic CSS variables in `:root` (e.g., `--background`), (2) `@theme inline` maps them to Tailwind's `--color-*` namespace so utility classes like `bg-background`, `text-foreground` work. [CITED: ui.shadcn.com/docs/tailwind-v4]

### Pattern 2: Vite Dev Server Proxy

**What:** Proxy WebSocket and font requests to relay server during development.
**When to use:** Development mode only. Production has relay serving the SPA directly.
**Source:** [CITED: vite.dev/config/server-options]

```typescript
// vite.config.ts
import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // WebSocket proxy to relay for client endpoint
      "/client": {
        target: "ws://localhost:3100",
        ws: true,
      },
      // WebSocket proxy to relay for proxy endpoint (if needed for debugging)
      "/proxy": {
        target: "ws://localhost:3100",
        ws: true,
      },
      // Font files proxy to relay
      "/fonts": {
        target: "http://localhost:3100",
      },
      // Health/API endpoints
      "/health": {
        target: "http://localhost:3100",
      },
    },
  },
});
```

**Relay runs on port 3100** with WebSocket endpoints at `/proxy` and `/client`, and static font serving at `/fonts`. [VERIFIED: apps/relay/src/index.ts L4, apps/relay/src/server.ts L54-71]

### Pattern 3: Monorepo TypeScript Configuration

**What:** TypeScript config for a Vite-based React app in the existing monorepo.
**When to use:** apps/web needs a different tsconfig than server-side apps (needs DOM lib, JSX).

The existing monorepo uses `tsconfig.base.json` with `ES2022` target, `ESNext` module, `bundler` moduleResolution. For a Vite React app, the base config is mostly compatible but needs DOM types added.

```jsonc
// apps/web/tsconfig.json (for project references)
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" }
  ]
}
```

```jsonc
// apps/web/tsconfig.app.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "noEmit": true,
    "composite": false,
    "declaration": false,
    "declarationMap": false,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src"],
  "references": [
    { "path": "../../packages/shared" }
  ]
}
```

```jsonc
// apps/web/tsconfig.node.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": ".",
    "lib": ["ES2022"],
    "noEmit": true,
    "composite": false,
    "declaration": false,
    "declarationMap": false
  },
  "include": ["vite.config.ts", "vitest.config.ts"]
}
```

**Key difference from server apps:** The tsconfig.app.json needs `"jsx": "react-jsx"`, `"lib": ["ES2022", "DOM", "DOM.Iterable"]`, and `"noEmit": true` (Vite handles compilation, not tsc). Also `composite: false` and no declaration output since Vite apps don't need to be referenced by other TypeScript projects.

### Pattern 4: shadcn/ui components.json

**What:** Configuration file that tells shadcn CLI how to install components.
**Source:** [CITED: ui.shadcn.com/docs/components-json]

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/app.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  }
}
```

**Notes:**
- `"config": ""` -- leave blank for Tailwind v4 (no JS config file). [CITED: ui.shadcn.com/docs/components-json]
- `"rsc": false` -- not using React Server Components (this is a SPA).
- `"style": "new-york"` -- the "default" style is deprecated, new projects use "new-york". [CITED: ui.shadcn.com/docs/tailwind-v4]
- `"baseColor": "neutral"` -- closest to the VS Code gray scale we're using.

### Pattern 5: index.html Font Loading

**What:** Static font CSS link in index.html for Sarasa Fixed SC.
**Source:** Locked decision D-06.

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CC Anywhere</title>
  <link rel="stylesheet" href="/fonts/sarasa-fixed-sc/result.css" />
</head>
<body class="bg-background text-foreground">
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

In dev mode, `/fonts/sarasa-fixed-sc/result.css` is proxied to relay at `localhost:3100` via Vite proxy. The CSS file contains ~254 `@font-face` declarations with `unicode-range` subsets, generated by cn-font-split. Browsers only download the woff2 files needed for characters actually displayed. [VERIFIED: font file count 254, generated by cn-font-split@7.6.8]

### Anti-Patterns to Avoid

- **Using `tailwind.config.js` with Tailwind v4:** v4 uses CSS-first `@theme` directive. The JS config is for v3 only. The `@tailwindcss/vite` plugin replaces PostCSS config entirely.
- **Using HSL format for shadcn CSS variables:** Tailwind v4 + shadcn uses raw hex or OKLCH values, not the old `hsl(0 0% 100%)` unwrapped pattern from v3.
- **Adding a `postcss.config.js`:** The `@tailwindcss/vite` plugin handles everything. No PostCSS config needed.
- **Using `tailwindcss-animate`:** Deprecated for v4. Use `tw-animate-css` instead.
- **Setting `composite: true` in tsconfig.app.json:** Vite apps don't need TypeScript project references for build. `noEmit: true` is correct since Vite (esbuild) does the transpilation.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| CSS class merging | Custom className concatenation | `cn()` from `clsx` + `tailwind-merge` | Handles Tailwind class conflicts (e.g., `p-2 p-4` -> `p-4`) |
| Component variants | Manual conditional class strings | `class-variance-authority` (cva) | Type-safe variant definitions with Tailwind, used by all shadcn components |
| Font subsetting | Custom font loading logic | cn-font-split (already done) | 254 unicode-range subsets already generated, browser handles lazy loading |
| Button component | Custom button with variants | shadcn/ui Button | 7 variants, 8 sizes, asChild support, keyboard accessible |
| Animation utilities | Custom CSS animations | `tw-animate-css` | Standard animation classes compatible with Tailwind v4 |

## Common Pitfalls

### Pitfall 1: Tailwind v4 Import Order

**What goes wrong:** CSS imports in wrong order cause styles to not apply or get overridden.
**Why it happens:** `@import "tailwindcss"` must come before any `@theme` blocks. `tw-animate-css` must be imported after tailwindcss.
**How to avoid:** Follow this exact order in app.css: `@import "tailwindcss"` -> `@import "tw-animate-css"` -> `:root` variables -> `@theme inline` -> `@theme` extensions -> custom styles.
**Warning signs:** Utility classes don't work, background color doesn't apply.

### Pitfall 2: Vite WebSocket Proxy with ws: true

**What goes wrong:** WebSocket connections fail with 404 or connection refused.
**Why it happens:** Must use `ws: true` option for WebSocket proxy targets. The target URL for WebSocket should use `ws://` protocol prefix.
**How to avoid:** Explicitly set `ws: true` in proxy config for `/client` and `/proxy` endpoints. Use `ws://localhost:3100` as target for WebSocket-only endpoints.
**Warning signs:** WebSocket connection errors in browser devtools.

### Pitfall 3: pnpm Workspace Dependency Resolution

**What goes wrong:** `@cc-anywhere/shared` not found when running `pnpm install` in apps/web.
**Why it happens:** New app not properly declared in pnpm-workspace.yaml, or shared package not built.
**How to avoid:** `pnpm-workspace.yaml` already has `apps/*` glob, so `apps/web` is automatically included. Run `pnpm build` from root to build shared package first. Use `workspace:*` for shared dependency.
**Warning signs:** Module not found errors for `@cc-anywhere/shared`.

### Pitfall 4: Font Proxy CORS in Development

**What goes wrong:** Font files blocked by CORS in development.
**Why it happens:** Font file loaded from different origin (relay on port 3100, Vite on 5173).
**How to avoid:** The Vite proxy makes `/fonts` requests go through Vite's dev server first, so the browser sees same-origin. Relay already sets `Access-Control-Allow-Origin: *` on `/fonts` as fallback. [VERIFIED: apps/relay/src/server.ts L38-40]
**Warning signs:** Font not loading, CORS errors in console.

### Pitfall 5: TypeScript Path Aliases Not Working

**What goes wrong:** `@/components/ui/button` imports fail at build or type-check time.
**Why it happens:** Path aliases must be configured in BOTH tsconfig AND vite.config.ts `resolve.alias`.
**How to avoid:** Add `"paths": { "@/*": ["./src/*"] }` to tsconfig.app.json AND `resolve.alias: { "@": path.resolve(__dirname, "./src") }` to vite.config.ts.
**Warning signs:** "Module not found" errors with `@/` prefix.

### Pitfall 6: Root tsconfig.json Project References

**What goes wrong:** `tsc -b` (typecheck from root) fails for the new web app.
**Why it happens:** Root `tsconfig.json` needs a reference to `apps/web`, and apps/web needs proper project reference structure.
**How to avoid:** Add `{ "path": "apps/web" }` to root `tsconfig.json` references. The apps/web/tsconfig.json should reference tsconfig.app.json and tsconfig.node.json.
**Warning signs:** `tsc -b` errors about unreferenced project.

## Code Examples

### cn() Utility (shadcn standard)

```typescript
// src/lib/utils.ts
// Source: shadcn/ui standard pattern
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

### React 19 Root Mount

```typescript
// src/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

### Status Color Recommendation

Status colors harmonized with dark theme and #00D4AA accent. [ASSUMED -- Claude's discretion per D-03]

| Status | Color | Rationale |
|--------|-------|-----------|
| working | `#4FC1FF` | Cool blue, high visibility on dark bg, distinct from accent green |
| success | `#00D4AA` | Reuse accent color -- success IS the "good" state |
| warning | `#E8AB5A` | Warm amber, not too saturated, readable on dark surfaces |
| error | `#F44747` | VS Code's error red, familiar to developers |

### vitest.config.ts for Web App

```typescript
// apps/web/vitest.config.ts
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const scope = process.env.TEST_SCOPE;

const include =
  scope === "unit"
    ? ["src/__tests__/unit/**/*.test.ts", "src/__tests__/unit/**/*.test.tsx"]
    : scope === "integration"
      ? ["src/__tests__/integration/**/*.test.ts", "src/__tests__/integration/**/*.test.tsx"]
      : ["src/**/*.test.ts", "src/**/*.test.tsx"];

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "@cc-anywhere/shared": resolve(__dirname, "../../packages/shared/src/index.ts"),
    },
  },
  test: {
    name: "web",
    root: __dirname,
    include,
    environment: "jsdom",
  },
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `tailwind.config.js` (JavaScript) | `@theme` directive (CSS-first) | Tailwind v4.0, Jan 2025 | No JS config needed. Tokens are CSS variables. |
| `tailwindcss-animate` | `tw-animate-css` | shadcn/ui v4 update, 2025 | Direct replacement, same functionality. |
| HSL color format in shadcn | Hex/OKLCH colors | shadcn/ui Tailwind v4 update | Simpler syntax, no `hsl()` wrapper gymnastics. |
| PostCSS plugin for Tailwind | `@tailwindcss/vite` plugin | Tailwind v4.0 | Direct Vite integration, faster builds. |
| `forwardRef` in components | Direct `ref` prop (React 19) | React 19, Apr 2024 | shadcn/ui v4 components no longer use forwardRef. |
| shadcn "default" style | shadcn "new-york" style | 2025 | "default" deprecated. "new-york" is the only maintained style. |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Status colors (#4FC1FF working, #E8AB5A warning) are visually harmonious | Code Examples | LOW -- colors can be trivially adjusted; Token Showcase page validates visually |
| A2 | `@types/node` latest is ^22.x | Standard Stack | LOW -- exact version doesn't matter, just need it for path module types |
| A3 | `@types/react-dom` ^19.x matches react-dom 19 | Standard Stack | LOW -- pnpm will resolve correct version |
| A4 | shadcn `init` works correctly with pre-configured components.json | Architecture Patterns | MEDIUM -- may need to run init interactively first time; components.json can be manually created |

## Open Questions

1. **React Router setup scope**
   - What we know: Phase 8 (FRONT-09) handles phase-machine state with react-router. Phase 7 only needs scaffold.
   - What's unclear: Should we install react-router now but defer configuration, or skip entirely?
   - Recommendation: Install the dependency now. Create a minimal `BrowserRouter` wrapper in App but only render the Token Showcase page. This avoids a dependency-adding step in Phase 8.

2. **Root tsconfig.json composite constraints**
   - What we know: Existing root tsconfig uses project references with `composite: true` in base. Vite apps use `noEmit: true` which conflicts with `composite: true`.
   - What's unclear: Whether the root `tsc -b` will work with a non-composite sub-project reference.
   - Recommendation: Use a `tsconfig.json` in apps/web that references tsconfig.app.json (for src) and tsconfig.node.json (for config files), similar to Vite's standard template. The root tsconfig references `apps/web` which in turn delegates. Override `composite: false` and `noEmit: true` in tsconfig.app.json.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | Yes | v22.16.0 | -- |
| pnpm | Package management | Yes | 10.12.4 | -- |
| Relay server | Font proxy, WebSocket proxy | Runtime (start manually) | -- | Dev server still starts without relay; proxy failures are non-fatal |
| Sarasa Fixed SC fonts | Terminal display | Yes (254 woff2 files) | cn-font-split@7.6.8 | -- |

**Missing dependencies with no fallback:** None -- all required tooling is available.

**Missing dependencies with fallback:**
- Relay server must be running for font/WebSocket proxy to work during dev. If not running, Vite dev server still starts; font loading and WebSocket will fail silently until relay is started.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest ^4.1.2 (monorepo root) |
| Config file | `apps/web/vitest.config.ts` (needs creation -- Wave 0) |
| Quick run command | `pnpm --filter web test` |
| Full suite command | `pnpm test` (runs all workspace tests) |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| FRONT-01 | Vite build produces dist/ with index.html and assets | smoke | `pnpm --filter web build && test -f apps/web/dist/index.html` | No -- Wave 0 |
| FRONT-01 | React app mounts without errors | unit | `pnpm --filter web test -- src/__tests__/unit/app.test.tsx` | No -- Wave 0 |
| FRONT-02 | Design tokens CSS variables are defined on :root | unit | `pnpm --filter web test -- src/__tests__/unit/tokens.test.ts` | No -- Wave 0 |
| FRONT-02 | Token Showcase page renders all sections | unit | `pnpm --filter web test -- src/__tests__/unit/token-showcase.test.tsx` | No -- Wave 0 |
| DEPLOY-02 | Vite proxy config has correct targets | unit | `pnpm --filter web test -- src/__tests__/unit/vite-config.test.ts` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm --filter web test`
- **Per wave merge:** `pnpm test` (full monorepo suite)
- **Phase gate:** Full suite green + visual verification of Token Showcase page

### Wave 0 Gaps
- [ ] `apps/web/vitest.config.ts` -- test configuration with jsdom environment
- [ ] `apps/web/src/__tests__/unit/app.test.tsx` -- covers FRONT-01 (React mount)
- [ ] `apps/web/src/__tests__/unit/tokens.test.ts` -- covers FRONT-02 (CSS variable validation)
- [ ] `apps/web/src/__tests__/unit/token-showcase.test.tsx` -- covers FRONT-02 (Token Showcase renders)

## Security Domain

This phase involves no authentication, session management, access control, or cryptography. It's a static UI scaffold with design tokens.

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | -- |
| V3 Session Management | No | -- |
| V4 Access Control | No | -- |
| V5 Input Validation | No | -- (no user input in this phase) |
| V6 Cryptography | No | -- |

No security concerns for this phase. Future phases (WebSocket connection, user input) will need security review.

## Project Constraints (from CLAUDE.md)

Directives extracted from project-level CLAUDE.md that affect this phase:

- **Language:** Log messages in English, comments and docstrings in Chinese
- **No emoji** in code
- **No deferred imports** unless circular dependency exists
- **System font stack** for UI text (matches D-04)
- **ESM-only** project (`"type": "module"` in package.json)
- **Vitest** for testing (monorepo root already configured)
- **Prettier** formatting: semi, double quotes, trailing commas, 100 char width
- **ESLint** with flat config, TypeScript rules
- **pnpm** workspace monorepo
- **UI/UX needs approval** -- Token Showcase page design must be reviewed before implementation
- **Test before commit** -- visual verification required for UI changes

## Sources

### Primary (HIGH confidence)
- [npm registry] -- All package versions verified via `npm view` (vite 8.0.8, react 19.2.5, tailwindcss 4.2.2, etc.)
- [apps/relay/src/server.ts] -- Relay WebSocket endpoints `/proxy`, `/client`, font serving at `/fonts`
- [apps/relay/src/index.ts] -- Relay port 3100
- [tailwindcss.com/docs/theme] -- @theme directive, CSS variable namespaces, design token patterns
- [ui.shadcn.com/docs/installation/vite] -- Complete Vite + React + shadcn/ui setup steps
- [ui.shadcn.com/docs/tailwind-v4] -- Tailwind v4 migration, @theme inline pattern, tw-animate-css
- [ui.shadcn.com/docs/theming] -- CSS variable list for shadcn/ui components
- [ui.shadcn.com/docs/components-json] -- components.json configuration
- [vite.dev/config/server-options] -- server.proxy with ws: true for WebSocket

### Secondary (MEDIUM confidence)
- [ui.shadcn.com/docs/components/button] -- Button variants and sizes (7 variants, 8 sizes)

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all versions verified against npm registry, setup steps verified against official docs
- Architecture: HIGH -- patterns sourced from official Tailwind v4 docs, shadcn/ui docs, and existing monorepo conventions
- Pitfalls: HIGH -- based on known Tailwind v4 migration issues and Vite proxy behavior documented in official sources
- Design tokens: HIGH for structure, MEDIUM for specific status color values (subjective visual judgment)

**Research date:** 2026-04-15
**Valid until:** 2026-05-15 (stable ecosystem, 30-day validity)
