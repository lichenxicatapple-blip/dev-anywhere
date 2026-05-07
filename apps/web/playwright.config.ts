import { defineConfig } from "@playwright/test";

// 本地 Vite 默认 5173，可通过 WEB_BASE_URL 环境变量覆盖
// 不配置 webServer：开发期由外层脚本或人工启动 Vite，避免 E2E 隐式重启正在调试的服务。
const BASE_URL = process.env.WEB_BASE_URL ?? "http://localhost:5173";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  use: {
    baseURL: BASE_URL,
  },
  projects: [
    // 移动端视口覆盖抽屉、软键盘和窄屏滚动路径。
    {
      name: "mobile",
      use: { viewport: { width: 390, height: 844 }, hasTouch: true },
    },
    // 桌面视口覆盖 master-detail、侧栏和宽屏终端路径。
    {
      name: "desktop",
      use: { viewport: { width: 1280, height: 800 } },
    },
  ],
});
