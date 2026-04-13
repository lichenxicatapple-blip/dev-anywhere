import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  use: {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  },
});
