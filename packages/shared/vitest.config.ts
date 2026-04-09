import { defineConfig } from "vitest/config";

const scope = process.env.TEST_SCOPE;

export default defineConfig({
  test: {
    name: "shared",
    include: scope === "integration" ? [] : ["src/**/*.test.ts"],
  },
});
