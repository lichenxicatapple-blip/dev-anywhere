import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "proxy",
    root: ".",
    include: ["src/**/*.test.ts"],
  },
});
