import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    name: "relay",
    root: __dirname,
    include: ["src/**/*.test.ts"],
  },
});
