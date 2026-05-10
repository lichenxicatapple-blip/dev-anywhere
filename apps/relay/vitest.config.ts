import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const scope = process.env.TEST_SCOPE;

const include =
  scope === "unit"
    ? ["src/__tests__/unit/**/*.test.ts"]
    : scope === "integration"
      ? ["src/__tests__/integration/**/*.test.ts"]
      : ["src/**/*.test.ts"];

export default defineConfig({
  resolve: {
    alias: {
      // 顺序敏感：subpath 别名必须放在裸包名之前，否则 "@dev-anywhere/shared/logger" 会先
      // 命中 "@dev-anywhere/shared" 的 alias 被拼成 ".../src/index.ts/logger"。
      "@dev-anywhere/shared/logger": resolve(__dirname, "../../packages/shared/src/logger.ts"),
      "@dev-anywhere/shared": resolve(__dirname, "../../packages/shared/src/index.ts"),
    },
  },
  test: {
    name: "relay",
    root: __dirname,
    include,
  },
});
