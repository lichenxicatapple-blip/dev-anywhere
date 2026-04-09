import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const scope = process.env.TEST_SCOPE;

const include =
  scope === "unit"
    ? ["src/__tests__/unit/**/*.test.ts"]
    : scope === "integration"
      ? ["src/__tests__/integration/**/*.test.ts"]
      : ["src/**/*.test.ts"];

export default defineConfig({
  test: {
    name: "proxy",
    root: __dirname,
    include,
  },
});
