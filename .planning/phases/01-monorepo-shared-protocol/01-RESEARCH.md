# Phase 1: Monorepo & Shared Protocol - Research

**Researched:** 2026-04-03
**Domain:** pnpm monorepo scaffolding + Zod message protocol schema
**Confidence:** HIGH

## Summary

Phase 1 is pure infrastructure: set up a pnpm workspace monorepo with four packages (shared, proxy, relay, feishu), establish a build/lint/test toolchain, and define the MessageEnvelope + all message type schemas in Zod. No business logic, no runtime services. The output is a compilable, testable, lintable project skeleton where changing a type in `packages/shared` immediately causes compile errors in dependent packages.

Key technical finding: Zod has released v4 (stable since July 2025, currently 4.3.6). STACK.md references ^3.24 but for a greenfield project, Zod 4 is the correct choice -- it's 14x faster string parsing, 57% smaller bundle, and `import { z } from "zod"` now exports v4 directly. Vitest has also advanced to 4.x (currently 4.1.2) with the `projects` config replacing the deprecated workspace file. ESLint is now at v10 with flat config as the only option.

**Primary recommendation:** Use Zod 4, Vitest 4, ESLint 10, TypeScript 5.5+, tsup 8, pnpm 10. All ESM-only. Use `workspace:*` protocol for cross-package references. TypeScript project references for incremental builds and compile-time dependency enforcement.

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** 消息类型按功能分为四大类：chat (user_input, assistant_message, thinking), tool (tool_use_request, tool_approve, tool_deny, tool_result), session (session_create, session_list, session_switch, session_terminate, session_status), system (heartbeat, error, auth, sync_request, sync_response)
- **D-02:** MessageEnvelope 带元数据：seq（序列号）、sessionId、type、payload、timestamp、source（proxy/client）、version
- **D-03:** 流式输出粒度为 Agent SDK 事件级，每个 SDKMessage 事件作为一条完整消息发送到小程序，不做 token 级流式
- **D-04:** 统一错误消息类型，所有错误通过 error 类型消息传递，包含错误码和描述
- **D-05:** 认证采用配对码方案：首次连接时本地代理生成 6 位配对码（5 分钟有效），用户在飞书小程序输入后建立绑定，双方获得长期 token 用于后续自动认证，无需重复配对
- **D-06:** 采用 apps/ + packages/ 分离布局：apps/{proxy,relay,feishu} 为可部署应用，packages/shared 为共享库
- **D-07:** npm scope 使用 @cc-anywhere/*（如 @cc-anywhere/shared、@cc-anywhere/proxy）
- **D-08:** 构建工具使用 tsup，测试框架使用 vitest
- **D-09:** Lint 使用 ESLint，格式化使用 Prettier
- **D-10:** shared 包包含：zod schema 定义、TypeScript 类型导出（从 zod infer）、消息构造器函数、序列号生成器、常量定义（错误码枚举、会话状态枚举）。不包含 WebSocket 连接逻辑、持久化逻辑、业务逻辑。
- **D-11:** 包间严格单向依赖：shared 无依赖，proxy/relay/feishu 只依赖 shared，三者互不依赖。如 relay 有类型需要 feishu 用，提升到 shared。
- **D-12:** packages/shared/src/ 下按职责分目录：schemas/（按消息类别拆文件：envelope.ts、chat.ts、tool.ts、session.ts、system.ts）、types/（从 zod infer 的 TS 类型）、builders/（消息构造器）、constants/（错误码、会话状态枚举）

### Claude's Discretion
- 无（所有设计决策已确定）

### Deferred Ideas (OUT OF SCOPE)
- 飞书小程序通知能力（用户离开后任务完成时通知，回到电脑后自动屏蔽通知） -- Phase 10 (UX-03)

</user_constraints>

## Project Constraints (from CLAUDE.md)

- 日志信息使用英语
- 注释和 docstring 使用中文
- 代码中不允许使用 emoji
- git commit message 简洁精炼
- 不要使用延迟导入，除非确实存在循环依赖
- 使用 rmtrash 代替 rm
- 错误应明确抛出，避免静默 fallback
- 避免在代码中硬编码目录路径

## Standard Stack

### Core (Phase 1 only -- packages needed for monorepo scaffolding and shared protocol)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `zod` | ^4.3.6 | Message schema definition & runtime validation | v4 stable since July 2025. 14x faster parsing, 57% smaller. `import { z } from "zod"` now exports v4. Greenfield project -- no migration burden. |
| `nanoid` | ^5.1.7 | Generate compact unique IDs for message sequence, session IDs | URL-safe, fast, tiny. ESM-only aligns with project. |
| `typescript` | ^5.8.2 | Language | Project constraint. Use latest 5.x for best project references support. |
| `tsup` | ^8.5.1 | Bundle shared package to ESM + .d.ts | Zero-config, esbuild-powered. Generates declaration files. |
| `vitest` | ^4.1.2 | Testing framework | v4 current. `projects` config replaces deprecated workspace file. |
| `eslint` | ^10.1.0 | Linting (flat config only) | v10 removes legacy eslintrc entirely. Flat config locates from linted file dir, ideal for monorepos. |
| `typescript-eslint` | ^8.58.0 | TypeScript-aware ESLint rules | Works with ESLint 10 flat config. |
| `@eslint/js` | ^10.0.1 | ESLint recommended rules preset | Official ESLint JS rules for flat config. |
| `prettier` | ^3.8.1 | Code formatting | Standard. |
| `eslint-config-prettier` | ^10.1.8 | Disable ESLint rules that conflict with Prettier | Prevents formatting conflicts. |
| `tsx` | ^4.21.0 | TypeScript execution for development | Faster than ts-node. For running scripts during development. |
| `globals` | ^17.4.0 | Global variable definitions for ESLint flat config | Required by ESLint 10 flat config for `node` globals. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Zod 4 | Zod 3 (^3.24) | Zod 3 still available via `zod/v3`. No reason for greenfield project. |
| tsup | tsdown | tsdown is tsup's successor but not mature enough yet (STACK.md notes this). |
| ESLint 10 | ESLint 9 | v9 still works but v10 is current and removes legacy config entirely -- cleaner for new project. |
| Vitest 4 | Vitest 3 | v3 deprecated workspace config; v4 uses `projects` -- simpler. |
| nanoid | uuid | uuid generates v4 UUIDs (36 chars). nanoid is 21 chars, URL-safe, faster. |

**Installation (root-level dev dependencies):**

```bash
pnpm add -D -w typescript tsup vitest tsx eslint @eslint/js typescript-eslint eslint-config-prettier prettier globals
```

**Installation (packages/shared):**

```bash
cd packages/shared && pnpm add zod nanoid
```

**Version verification (2026-04-03):**

| Package | Registry Version | Verified |
|---------|-----------------|----------|
| zod | 4.3.6 | Yes |
| nanoid | 5.1.7 | Yes |
| typescript | 6.0.2 | Yes (use ^5.8 for stability; 6.0 just released, wait for ecosystem) |
| tsup | 8.5.1 | Yes |
| vitest | 4.1.2 | Yes |
| eslint | 10.1.0 | Yes |
| typescript-eslint | 8.58.0 | Yes |
| prettier | 3.8.1 | Yes |
| tsx | 4.21.0 | Yes |
| globals | 17.4.0 | Yes |

**NOTE on TypeScript 6.0:** npm shows TypeScript 6.0.2 as latest, but it was just released. For stability, pin `^5.8` in Phase 1. TypeScript 6.x may have breaking changes that affect the ecosystem (ESLint plugins, tsup DTS generation). Upgrade to 6.x in a later phase once the ecosystem catches up.

## Architecture Patterns

### Recommended Project Structure

```
cc-anywhere/
├── pnpm-workspace.yaml
├── package.json                  # root: scripts, devDependencies
├── tsconfig.base.json            # shared compiler options
├── tsconfig.json                 # project references only (for IDE)
├── eslint.config.js              # root flat config
├── .prettierrc                   # prettier config
├── vitest.config.ts              # root: projects: ['packages/*', 'apps/*']
├── apps/
│   ├── proxy/                    # Phase 2+: local CLI proxy
│   │   ├── package.json
│   │   ├── tsconfig.json         # extends ../../tsconfig.base.json
│   │   └── src/
│   ├── relay/                    # Phase 4+: relay server
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   └── feishu/                   # Phase 6+: mini program
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
└── packages/
    └── shared/                   # Phase 1: message protocol
        ├── package.json
        ├── tsconfig.json
        ├── tsup.config.ts
        └── src/
            ├── index.ts          # barrel export
            ├── schemas/
            │   ├── envelope.ts   # MessageEnvelope schema
            │   ├── chat.ts       # chat message schemas
            │   ├── tool.ts       # tool message schemas
            │   ├── session.ts    # session message schemas
            │   └── system.ts     # system message schemas
            ├── types/
            │   └── index.ts      # z.infer<> type exports
            ├── builders/
            │   └── index.ts      # message constructor functions
            └── constants/
                ├── errors.ts     # error code enum
                └── session.ts    # session state enum
```

### Pattern 1: pnpm Workspace + TypeScript Project References

**What:** Combine pnpm's `workspace:*` protocol for runtime dependency resolution with TypeScript's `references` for compile-time dependency tracking.

**Configuration:**

`pnpm-workspace.yaml`:
```yaml
packages:
  - 'packages/*'
  - 'apps/*'
```

`tsconfig.base.json` (shared compiler options, no files):
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true
  }
}
```

`tsconfig.json` (root, for IDE -- references only):
```json
{
  "files": [],
  "references": [
    { "path": "packages/shared" },
    { "path": "apps/proxy" },
    { "path": "apps/relay" },
    { "path": "apps/feishu" }
  ]
}
```

`packages/shared/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

`apps/proxy/tsconfig.json` (and similar for relay, feishu):
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "references": [
    { "path": "../../packages/shared" }
  ]
}
```

### Pattern 2: workspace:* Cross-Package References

**What:** Each app package declares shared as a workspace dependency. pnpm symlinks it automatically.

`apps/proxy/package.json`:
```json
{
  "name": "@cc-anywhere/proxy",
  "dependencies": {
    "@cc-anywhere/shared": "workspace:*"
  }
}
```

`packages/shared/package.json`:
```json
{
  "name": "@cc-anywhere/shared",
  "version": "0.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^4.3.6",
    "nanoid": "^5.1.7"
  }
}
```

### Pattern 3: Zod 4 Discriminated Union for MessageEnvelope

**What:** Use `z.discriminatedUnion` on the `type` field to create a type-safe envelope where each message type has a precisely typed payload.

**Why:** This is the core schema pattern. Every message between proxy/relay/feishu goes through this envelope. Zod's discriminated union gives both runtime validation and TypeScript inference.

**Example:**

```typescript
// packages/shared/src/schemas/chat.ts
import { z } from "zod";

export const UserInputPayloadSchema = z.object({
  text: z.string(),
});

export const AssistantMessagePayloadSchema = z.object({
  text: z.string(),
  isPartial: z.boolean(),
});

export const ThinkingPayloadSchema = z.object({
  text: z.string(),
});

// packages/shared/src/schemas/envelope.ts
import { z } from "zod";
import { UserInputPayloadSchema, AssistantMessagePayloadSchema, ThinkingPayloadSchema } from "./chat.js";
// ... other payload imports

const MessageSource = z.enum(["proxy", "client"]);

const BaseEnvelope = z.object({
  seq: z.number().int().nonneg(),
  sessionId: z.string(),
  timestamp: z.number(),
  source: MessageSource,
  version: z.string(),
});

export const MessageEnvelopeSchema = z.discriminatedUnion("type", [
  BaseEnvelope.extend({
    type: z.literal("user_input"),
    payload: UserInputPayloadSchema,
  }),
  BaseEnvelope.extend({
    type: z.literal("assistant_message"),
    payload: AssistantMessagePayloadSchema,
  }),
  BaseEnvelope.extend({
    type: z.literal("thinking"),
    payload: ThinkingPayloadSchema,
  }),
  // ... all other message types
]);

export type MessageEnvelope = z.infer<typeof MessageEnvelopeSchema>;
```

**Zod 4 specific notes:**
- `.extend()` replaces deprecated `.merge()` for adding fields to object schemas
- `z.enum()` now accepts TypeScript enums and enum-like objects directly (no need for `z.nativeEnum()`)
- `z.infer<>` works the same as v3
- `z.discriminatedUnion()` works the same as v3 but error messages have changed (no longer lists possible discriminator values on invalid input)

### Pattern 4: Message Builder Functions

**What:** Factory functions that create validated message envelopes with auto-generated metadata.

```typescript
// packages/shared/src/builders/index.ts
import { nanoid } from "nanoid";
import { type MessageEnvelope, MessageEnvelopeSchema } from "../schemas/envelope.js";

let sequenceCounter = 0;

export function createSequenceId(): number {
  return sequenceCounter++;
}

export function resetSequenceCounter(value = 0): void {
  sequenceCounter = value;
}

export function buildMessage<T extends MessageEnvelope["type"]>(
  type: T,
  sessionId: string,
  payload: Extract<MessageEnvelope, { type: T }>["payload"],
  source: "proxy" | "client",
): Extract<MessageEnvelope, { type: T }> {
  const envelope = {
    seq: createSequenceId(),
    sessionId,
    type,
    payload,
    timestamp: Date.now(),
    source,
    version: "1.0",
  };
  return MessageEnvelopeSchema.parse(envelope) as Extract<MessageEnvelope, { type: T }>;
}
```

### Pattern 5: ESLint 10 Flat Config for Monorepo

```javascript
// eslint.config.js
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },
);
```

### Pattern 6: Vitest 4 Projects Config for Monorepo

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*"],
  },
});
```

Each package has its own vitest config:
```typescript
// packages/shared/vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
```

### Pattern 7: tsup Config for Shared Package

```typescript
// packages/shared/tsup.config.ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
```

ESM-only output since all consumers are internal workspace packages. No CJS needed.

### Anti-Patterns to Avoid

- **Barrel re-exports everywhere:** Don't create deep barrel re-export chains. One `index.ts` at `packages/shared/src/` is enough. Deep barrels cause circular dependency issues and slow TypeScript.
- **Zod 3 import path:** Don't use `import { z } from "zod/v3"`. New project = Zod 4 from `"zod"`.
- **Vitest workspace file:** Don't create `vitest.workspace.ts` -- it's deprecated in v3.2+. Use `projects` in root `vitest.config.ts`.
- **Legacy ESLint config (.eslintrc):** ESLint 10 does not support it at all. Only `eslint.config.js`.
- **tsconfig `paths` for workspace packages:** Don't use TypeScript path aliases to map `@cc-anywhere/shared`. Let pnpm's `workspace:*` and Node module resolution handle it. Paths aliases create a second source of truth that drifts.
- **Putting apps/ packages in packages/:** The decision is `apps/{proxy,relay,feishu}` + `packages/shared`. Don't mix them.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Schema validation + type inference | Custom type guards and validators | Zod 4 `z.discriminatedUnion` | Zod gives both runtime validation and TypeScript types from a single schema definition. Hand-rolling type guards for 16+ message types is error-prone and unmaintainable. |
| Unique ID generation | `Math.random().toString(36)` | `nanoid` | Collision resistance, URL-safe, configurable length. |
| Monorepo dependency linking | npm link / manual symlinks | pnpm `workspace:*` protocol | Automatic symlink management, single lockfile, strict isolation. |
| TypeScript build orchestration | Custom build scripts | TypeScript project references + tsup | Incremental compilation, compile-time dependency enforcement. |
| Config file formatting | Custom scripts | Prettier | Standard, zero-config for JSON/YAML/TS/JS. |

## Common Pitfalls

### Pitfall 1: Missing `"type": "module"` in package.json

**What goes wrong:** ESM imports fail at runtime with "Cannot use import statement outside a module" or "require() of ES modules is not supported".
**Why it happens:** Node.js defaults to CJS. Zod 4, nanoid 5 are ESM-only packages.
**How to avoid:** Every package.json must have `"type": "module"`. Root and all sub-packages.
**Warning signs:** `ERR_REQUIRE_ESM` errors.

### Pitfall 2: Forgetting `.js` Extensions in TypeScript Imports

**What goes wrong:** TypeScript compiles fine but runtime fails with "Cannot find module".
**Why it happens:** With `"type": "module"` and `"moduleResolution": "bundler"`, TypeScript allows extensionless imports during compilation. But if running the compiled output directly with Node.js (without a bundler), Node requires `.js` extensions. tsup handles this during bundling, but tests run directly via vitest which uses its own resolution.
**How to avoid:** Use `.js` extensions in all imports within `packages/shared/src/` (e.g., `import { x } from "./chat.js"`). This is compatible with both bundlers and direct Node execution. Vitest resolves these correctly.
**Warning signs:** Tests pass but `node dist/index.js` fails.

### Pitfall 3: Circular Dependencies Between Schema Files

**What goes wrong:** Runtime error "Cannot access 'X' before initialization" or undefined exports.
**Why it happens:** `envelope.ts` imports from `chat.ts`, `tool.ts`, etc. If any of those import back from `envelope.ts`, you get a cycle.
**How to avoid:** Strict import direction: category schema files (chat.ts, tool.ts, etc.) define payload schemas only and never import from envelope.ts. Only envelope.ts imports from category files. Types can be re-exported from a separate `types/index.ts` that imports from compiled schemas.
**Warning signs:** `undefined` values in schema definitions at import time.

### Pitfall 4: tsup DTS Generation Failing with Project References

**What goes wrong:** `tsup --dts` fails with "TS6307: File is not listed within the file list of project" errors.
**Why it happens:** tsup's DTS generation uses the TypeScript compiler API internally and can conflict with `composite: true` project references settings.
**How to avoid:** In `packages/shared/tsconfig.json`, ensure `rootDir` and `include` are correctly scoped. If issues persist, use `tsup --dts-resolve` or separate the DTS generation step: `tsc --emitDeclarationOnly && tsup --no-dts`.
**Warning signs:** Build succeeds for JS but fails for type declarations.

### Pitfall 5: Vitest Not Finding Tests in Monorepo Sub-Packages

**What goes wrong:** `pnpm test` at root finds no tests.
**Why it happens:** The root `vitest.config.ts` needs `projects` pointing to sub-packages, and each sub-package needs either a `vitest.config.ts` or test files matching the default pattern.
**How to avoid:** Root config with `projects: ["packages/*", "apps/*"]`. Each package has its own `vitest.config.ts` with `include` pattern.
**Warning signs:** "No test files found" when running from root.

### Pitfall 6: pnpm install Not Linking Workspace Packages

**What goes wrong:** `@cc-anywhere/shared` not found when imported from app packages.
**Why it happens:** Missing `workspace:*` in dependencies, or package names don't match.
**How to avoid:** Ensure `@cc-anywhere/shared` in `apps/proxy/package.json` dependencies matches the `name` field in `packages/shared/package.json`. Run `pnpm install` from root after any package.json change.
**Warning signs:** "Cannot find module '@cc-anywhere/shared'" errors.

### Pitfall 7: TypeScript 6.0 Ecosystem Incompatibility

**What goes wrong:** tsup, typescript-eslint, or other tools break with TypeScript 6.0.
**Why it happens:** TypeScript 6.0 was just released. Ecosystem tools may not yet support it.
**How to avoid:** Pin `typescript` to `^5.8` for Phase 1. Upgrade to 6.x once tsup and typescript-eslint confirm compatibility.
**Warning signs:** Unexpected compilation errors, plugin crashes.

## Code Examples

### Complete MessageEnvelope Schema Pattern

```typescript
// packages/shared/src/schemas/envelope.ts
import { z } from "zod";
import {
  UserInputPayloadSchema,
  AssistantMessagePayloadSchema,
  ThinkingPayloadSchema,
} from "./chat.js";
import {
  ToolUseRequestPayloadSchema,
  ToolApprovePayloadSchema,
  ToolDenyPayloadSchema,
  ToolResultPayloadSchema,
} from "./tool.js";
import {
  SessionCreatePayloadSchema,
  SessionListPayloadSchema,
  SessionSwitchPayloadSchema,
  SessionTerminatePayloadSchema,
  SessionStatusPayloadSchema,
} from "./session.js";
import {
  HeartbeatPayloadSchema,
  ErrorPayloadSchema,
  AuthPayloadSchema,
  SyncRequestPayloadSchema,
  SyncResponsePayloadSchema,
} from "./system.js";

const MessageSourceSchema = z.enum(["proxy", "client"]);

const BaseEnvelopeFields = {
  seq: z.number().int().nonneg(),
  sessionId: z.string(),
  timestamp: z.number(),
  source: MessageSourceSchema,
  version: z.string(),
};

// 使用 z.discriminatedUnion 实现按 type 字段自动分派 payload 类型
export const MessageEnvelopeSchema = z.discriminatedUnion("type", [
  // chat
  z.object({ ...BaseEnvelopeFields, type: z.literal("user_input"), payload: UserInputPayloadSchema }),
  z.object({ ...BaseEnvelopeFields, type: z.literal("assistant_message"), payload: AssistantMessagePayloadSchema }),
  z.object({ ...BaseEnvelopeFields, type: z.literal("thinking"), payload: ThinkingPayloadSchema }),
  // tool
  z.object({ ...BaseEnvelopeFields, type: z.literal("tool_use_request"), payload: ToolUseRequestPayloadSchema }),
  z.object({ ...BaseEnvelopeFields, type: z.literal("tool_approve"), payload: ToolApprovePayloadSchema }),
  z.object({ ...BaseEnvelopeFields, type: z.literal("tool_deny"), payload: ToolDenyPayloadSchema }),
  z.object({ ...BaseEnvelopeFields, type: z.literal("tool_result"), payload: ToolResultPayloadSchema }),
  // session
  z.object({ ...BaseEnvelopeFields, type: z.literal("session_create"), payload: SessionCreatePayloadSchema }),
  z.object({ ...BaseEnvelopeFields, type: z.literal("session_list"), payload: SessionListPayloadSchema }),
  z.object({ ...BaseEnvelopeFields, type: z.literal("session_switch"), payload: SessionSwitchPayloadSchema }),
  z.object({ ...BaseEnvelopeFields, type: z.literal("session_terminate"), payload: SessionTerminatePayloadSchema }),
  z.object({ ...BaseEnvelopeFields, type: z.literal("session_status"), payload: SessionStatusPayloadSchema }),
  // system
  z.object({ ...BaseEnvelopeFields, type: z.literal("heartbeat"), payload: HeartbeatPayloadSchema }),
  z.object({ ...BaseEnvelopeFields, type: z.literal("error"), payload: ErrorPayloadSchema }),
  z.object({ ...BaseEnvelopeFields, type: z.literal("auth"), payload: AuthPayloadSchema }),
  z.object({ ...BaseEnvelopeFields, type: z.literal("sync_request"), payload: SyncRequestPayloadSchema }),
  z.object({ ...BaseEnvelopeFields, type: z.literal("sync_response"), payload: SyncResponsePayloadSchema }),
]);

export type MessageEnvelope = z.infer<typeof MessageEnvelopeSchema>;
export type MessageType = MessageEnvelope["type"];
export type MessageSource = z.infer<typeof MessageSourceSchema>;
```

### Payload Schema Example (chat.ts)

```typescript
// packages/shared/src/schemas/chat.ts
import { z } from "zod";

export const UserInputPayloadSchema = z.object({
  text: z.string().min(1),
});

export const AssistantMessagePayloadSchema = z.object({
  text: z.string(),
  isPartial: z.boolean(),
});

export const ThinkingPayloadSchema = z.object({
  text: z.string(),
});
```

### Constants Example

```typescript
// packages/shared/src/constants/errors.ts
export const ErrorCode = {
  UNKNOWN: "UNKNOWN",
  AUTH_FAILED: "AUTH_FAILED",
  AUTH_EXPIRED: "AUTH_EXPIRED",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SESSION_TERMINATED: "SESSION_TERMINATED",
  INVALID_MESSAGE: "INVALID_MESSAGE",
  RATE_LIMIT: "RATE_LIMIT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// packages/shared/src/constants/session.ts
export const SessionState = {
  IDLE: "idle",
  WORKING: "working",
  WAITING_APPROVAL: "waiting_approval",
  ERROR: "error",
  TERMINATED: "terminated",
} as const;

export type SessionState = (typeof SessionState)[keyof typeof SessionState];
```

### Barrel Export

```typescript
// packages/shared/src/index.ts
export { MessageEnvelopeSchema, type MessageEnvelope, type MessageType, type MessageSource } from "./schemas/envelope.js";
export * from "./schemas/chat.js";
export * from "./schemas/tool.js";
export * from "./schemas/session.js";
export * from "./schemas/system.js";
export * from "./types/index.js";
export * from "./builders/index.js";
export { ErrorCode } from "./constants/errors.js";
export { SessionState } from "./constants/session.js";
```

### Test Example

```typescript
// packages/shared/src/schemas/__tests__/envelope.test.ts
import { describe, it, expect } from "vitest";
import { MessageEnvelopeSchema } from "../envelope.js";

describe("MessageEnvelopeSchema", () => {
  it("should validate a valid user_input message", () => {
    const msg = {
      seq: 0,
      sessionId: "sess-001",
      type: "user_input",
      payload: { text: "hello" },
      timestamp: Date.now(),
      source: "client",
      version: "1.0",
    };
    const result = MessageEnvelopeSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it("should reject invalid message type", () => {
    const msg = {
      seq: 0,
      sessionId: "sess-001",
      type: "invalid_type",
      payload: {},
      timestamp: Date.now(),
      source: "client",
      version: "1.0",
    };
    const result = MessageEnvelopeSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it("should reject missing required fields", () => {
    const msg = {
      type: "user_input",
      payload: { text: "hello" },
    };
    const result = MessageEnvelopeSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Zod 3 (`^3.24`) | Zod 4 (`^4.3.6`) | July 2025 | 14x faster parsing, 57% smaller bundle. `import { z } from "zod"` now v4. `.merge()` deprecated, use `.extend()`. |
| Vitest workspace file | Vitest `projects` config | Vitest 3.2 (2025) | `vitest.workspace.ts` deprecated. Use `projects` array in root `vitest.config.ts`. |
| ESLint .eslintrc | ESLint flat config only | ESLint 10 (April 2026) | Legacy config system removed entirely. `eslint.config.js` is the only option. |
| TypeScript 5.x | TypeScript 6.0 released | 2026 | Just released. Ecosystem not ready. Stick with ^5.8 for now. |
| `z.nativeEnum()` | `z.enum()` handles all enum types | Zod 4 | `z.nativeEnum()` deprecated. |
| `z.string().email()` | `z.email()` | Zod 4 | String format validators moved to top-level. |

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 4.1.2 |
| Config file | `vitest.config.ts` (root, with `projects`) + per-package configs |
| Quick run command | `pnpm vitest run --project shared` |
| Full suite command | `pnpm vitest run` |

### Phase Requirements -> Test Map

Phase 1 has no formal requirement IDs (infrastructure foundation), but success criteria are testable:

| Criterion | Behavior | Test Type | Automated Command | File Exists? |
|-----------|----------|-----------|-------------------|-------------|
| SC-01 | `pnpm install` sets up all four packages with cross-references | smoke | `pnpm install && pnpm ls -r --depth 0` | No (Wave 0) |
| SC-02 | Changing type in shared causes compile errors in dependents | unit | `tsc --noEmit` after introducing intentional type mismatch | No (Wave 0) |
| SC-03 | MessageEnvelope schema validates correctly via zod | unit | `pnpm vitest run --project shared` | No (Wave 0) |
| SC-04 | Project builds and lints cleanly | smoke | `pnpm build && pnpm lint` | No (Wave 0) |

### Sampling Rate

- **Per task commit:** `pnpm vitest run --project shared`
- **Per wave merge:** `pnpm build && pnpm lint && pnpm vitest run`
- **Phase gate:** Full suite green + `tsc --noEmit` across all packages

### Wave 0 Gaps

- [ ] `packages/shared/vitest.config.ts` -- per-package vitest config
- [ ] `vitest.config.ts` (root) -- projects config for monorepo
- [ ] `packages/shared/src/schemas/__tests__/envelope.test.ts` -- MessageEnvelope validation tests
- [ ] `packages/shared/src/schemas/__tests__/chat.test.ts` -- chat schema tests
- [ ] `packages/shared/src/schemas/__tests__/tool.test.ts` -- tool schema tests
- [ ] `packages/shared/src/schemas/__tests__/session.test.ts` -- session schema tests
- [ ] `packages/shared/src/schemas/__tests__/system.test.ts` -- system schema tests
- [ ] `packages/shared/src/builders/__tests__/builders.test.ts` -- message builder tests
- [ ] Framework install: `pnpm add -D -w vitest` -- part of root devDependencies setup

## Open Questions

1. **TypeScript 6.0 compatibility**
   - What we know: TypeScript 6.0.2 is the latest on npm as of 2026-04-03.
   - What's unclear: Whether tsup 8, typescript-eslint 8, and other tools fully support TS 6.0.
   - Recommendation: Pin `^5.8` for Phase 1. Investigate TS 6.0 compatibility in a later phase.

2. **Zod 4 `z.discriminatedUnion` with spread BaseEnvelopeFields**
   - What we know: Zod 4's `z.object({...baseFields}).extend()` works, as does `z.object({...spread})`.
   - What's unclear: Whether spreading a fields object into `z.object()` creates performance issues with 16 union members.
   - Recommendation: Start with spread approach (shown in examples). If performance is an issue (unlikely -- this is schema definition time, not parse time), refactor to use `.extend()`.

3. **Apps stub packages in Phase 1**
   - What we know: D-06 specifies apps/{proxy,relay,feishu} layout. Phase 1 only implements packages/shared.
   - What's unclear: Whether to create stub app packages in Phase 1 (to prove cross-references work) or defer to their respective phases.
   - Recommendation: Create minimal stubs (package.json + tsconfig.json + empty src/index.ts) for proxy, relay, feishu in Phase 1. This is needed to verify success criterion #1 ("pnpm install from repo root sets up all four packages with correct cross-references") and #2 ("Changing a type in shared causes type errors in dependent packages").

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | Yes | 22.16.0 | -- |
| pnpm | Package manager | Yes | 10.12.4 | -- |
| git | Version control | Yes | (system) | -- |

**Missing dependencies:** None. All required tools are available.

## Sources

### Primary (HIGH confidence)
- [Zod 4 API docs](https://zod.dev/api) -- schema definition, discriminated union, z.infer patterns
- [Zod 4 migration guide](https://zod.dev/v4/changelog) -- breaking changes from v3, new patterns
- [Zod 4 versioning](https://zod.dev/v4/versioning) -- confirmed v4 stable, root import exports v4
- [pnpm Workspaces](https://pnpm.io/workspaces) -- workspace protocol, configuration
- [ESLint 10 release](https://www.infoq.com/news/2026/04/eslint-10-release/) -- flat config only, file-based config resolution
- [Vitest Test Projects](https://vitest.dev/guide/projects) -- projects replacing deprecated workspace
- [tsup docs](https://tsup.egoist.dev/) -- DTS generation, ESM output, monorepo usage

### Secondary (MEDIUM confidence)
- [TypeScript ESLint flat config + monorepo](https://typescript-eslint.io/troubleshooting/typed-linting/monorepos/) -- project service model for typed linting
- [TypeScript Monorepo Best Practice 2026](https://hsb.horse/en/blog/typescript-monorepo-best-practice-2026/) -- confirmed pnpm + project references as standard
- npm registry version checks (2026-04-03) -- all versions verified against registry

### Tertiary (LOW confidence)
- TypeScript 6.0 ecosystem compatibility -- just released, no comprehensive compatibility data yet

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all versions verified against npm registry, Zod 4 documented as stable
- Architecture: HIGH -- pnpm workspace + TS project references is well-established pattern with multiple authoritative sources
- Pitfalls: HIGH -- common monorepo/ESM issues are well-documented
- Zod 4 specific patterns: MEDIUM -- Zod 4 API is documented but discriminated union with 16+ members using field spread is not extensively covered in examples

**Research date:** 2026-04-03
**Valid until:** 2026-05-03 (30 days -- stable domain, tools are mature)
