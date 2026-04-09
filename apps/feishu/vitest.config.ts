import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const scope = process.env.TEST_SCOPE;

export default defineConfig({
  test: {
    name: "feishu",
    root: __dirname,
    include: scope === "integration" ? [] : ["src/**/*.test.ts"],
  },
});
