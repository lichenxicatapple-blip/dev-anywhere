import { defineConfig } from "@playwright/test";

// 本地 Vite 默认 5173，可通过 WEB_BASE_URL 环境变量覆盖
// 不配置 webServer：dev server 由人工 pnpm --filter web dev 启动（参考 memory feedback_h5_testing）
const BASE_URL = process.env.WEB_BASE_URL ?? "http://localhost:5173";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  use: {
    baseURL: BASE_URL,
  },
  projects: [
    // 移动端视口：Plan 10-02 / 10-04 三页纵深
    {
      name: "mobile",
      use: { viewport: { width: 390, height: 844 }, hasTouch: true },
    },
    // 桌面视口：Plan 10-01b / 10-03 master-detail、10-06 split-pane
    {
      name: "desktop",
      use: { viewport: { width: 1280, height: 800 } },
    },
  ],
});
