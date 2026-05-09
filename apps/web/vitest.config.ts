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
      "@dev-anywhere/shared": resolve(__dirname, "../../packages/shared/src/index.ts"),
    },
  },
  test: {
    name: "web",
    root: __dirname,
    include,
    environment: "jsdom",
    setupFiles: ["src/test/setup-storage.ts"],
  },
});
