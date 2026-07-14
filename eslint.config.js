import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dist-h5/**",
      "**/test-results/**",
      "**/node_modules/**",
      "**/*.config.ts",
      "**/*.config.js",
      "**/*.config.cjs",
      "reference/**",
      "coverage/**",
      ".claude/worktrees/**",
      "**/scripts/**",
    ],
  },
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
  // React hooks 规则：仅应用于 apps/web 的 .ts/.tsx，避免误伤 proxy/relay 后端
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  // Playwright e2e fixture: 用 `use(...)` 注入依赖不是 React hook;
  // 空 destructure `{}` 表示显式无 fixture 依赖; 空 catch{} 是有意吞调试错误.
  {
    files: ["apps/web/e2e/fixtures/**/*.ts"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
      "no-empty-pattern": "off",
      "no-empty": "off",
    },
  },
  {
    files: ["apps/web/public/notification-sw.js"],
    languageOptions: {
      globals: { ...globals.serviceworker },
    },
  },
  // proxy 进程边界：terminal/serve/worker 三进程的私有代码不可互相导入。
  // common/ 和 ipc/ 是共享层，任意进程都可以用。
  // 下面四组规则覆盖了四种情形：三个进程各自的私有代码目录，以及共享层自身。
  {
    files: ["apps/proxy/src/terminal/**/*.ts", "apps/proxy/src/terminal.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/serve/**", "**/worker/**"],
              message: "terminal 进程不可导入 serve/worker 私有代码",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/proxy/src/serve/**/*.ts", "apps/proxy/src/serve.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/terminal/**", "**/worker/**"],
              message: "serve 进程不可导入 terminal/worker 私有代码",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/proxy/src/worker/**/*.ts", "apps/proxy/src/session-worker.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/terminal/**", "**/serve/**"],
              message: "worker 进程不可导入 terminal/serve 私有代码",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/proxy/src/common/**/*.ts", "apps/proxy/src/ipc/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/terminal/**", "**/serve/**", "**/worker/**"],
              message: "common/ipc 层不可依赖任何进程私有代码",
            },
          ],
        },
      ],
    },
  },
);
