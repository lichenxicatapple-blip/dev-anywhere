import { defineConfig } from "@playwright/test";

// 本地 Vite 默认 5173，可通过 WEB_BASE_URL 环境变量覆盖
// 不配置 webServer：开发期由外层脚本或人工启动 Vite，避免 E2E 隐式重启正在调试的服务。
const BASE_URL = process.env.WEB_BASE_URL ?? "http://localhost:5173";
const PC_OPT_IN_TESTS = ["**/real-*.spec.ts", "**/chaos/integration/*.spec.ts"];

export default defineConfig({
  // 每个 project 显式指定 testDir 对齐 tier (e2e/layout/ / e2e/pc/ / e2e/mobile/).
  // 顶层 testDir 留给 ad-hoc 命令行直接传相对路径.
  testDir: "./e2e",
  timeout: 30000,
  // 多 worker 并行下 cpu 抢占让 5s default expect timeout 偶发不够; 整 tier 提到 10s.
  expect: { timeout: 10_000 },
  // 整 tier 给 1 次 retry 容忍真 race / cpu 抢占 / vite HMR 抖动. 同条 spec 重试仍挂
  // 才视为真 fail. PC tier 96 个 spec 并行下不加 retry 偶发 flake 影响 release smoke.
  retries: 1,
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // L2 layout: viewport 模拟, 只查响应式断点, e2e/layout/.
    // 这些 spec 自己用 test.use / setViewportSize 覆盖具体断点; 单 project 避免
    // 同一批断言在多个 layout project 下重复执行。
    {
      name: "layout",
      testDir: "./e2e/layout",
      use: { viewport: { width: 375, height: 667 }, hasTouch: true },
    },
    // L3 device-pc: 真桌面 Chromium, e2e/pc/.
    {
      name: "device-pc",
      testDir: "./e2e/pc",
      testIgnore: PC_OPT_IN_TESTS,
      use: {},
    },
    // L3 opt-in: 真实 CLI/API/backend 和 dev:chaos 编排测试. 默认 PC tier 不跑这些文件;
    // scripts/test/pc.sh 在显式传入 real/chaos integration spec 时会切到该 project.
    {
      name: "device-pc-real",
      testDir: "./e2e/pc",
      testMatch: PC_OPT_IN_TESTS,
      use: {},
    },
    // L4 device-mobile-android: 真 Android emu via CDP, e2e/mobile/.
    // 前置: scripts/test/mobile.sh 起 vite + adb forward + chrome 9222.
    {
      name: "device-mobile-android",
      testDir: "./e2e/mobile",
      use: {},
    },
  ],
});
