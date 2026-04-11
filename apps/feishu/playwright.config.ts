import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  use: {
    viewport: { width: 390, height: 844 },
    launchOptions: {
      executablePath: process.env.CHROME_PATH
        || "/Users/admin/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    },
  },
});
