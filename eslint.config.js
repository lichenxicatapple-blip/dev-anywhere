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
);
