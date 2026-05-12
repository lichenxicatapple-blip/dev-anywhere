import { defineConfig } from "@playwright/test";

// 本地 Vite 默认 5173，可通过 WEB_BASE_URL 环境变量覆盖
// 不配置 webServer：开发期由外层脚本或人工启动 Vite，避免 E2E 隐式重启正在调试的服务。
const BASE_URL = process.env.WEB_BASE_URL ?? "http://localhost:5173";

// Node ≥ 25 下 Playwright 1.52 worker fork 会静默 hang (CPU 近 0、stdout 空、不退出),
// 项目已知症状, 之前一次 release 上踩过坑。scripts/web-e2e.sh wrapper 会自动切到 v22,
// 但裸跑 `pnpm exec playwright test` / IDE 集成绕过 wrapper 时仍会用当前 shell 的 node。
// 在 config 加载阶段拦下, 给清晰错误而不是让用户对着空 stdout 猜。
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
if (Number.isFinite(nodeMajor) && nodeMajor >= 25) {
  throw new Error(
    `Playwright 1.52 hangs under Node ${process.versions.node}. ` +
      `Use the wrapper which auto-switches to local Node 22:\n` +
      `  pnpm test:e2e <spec>\n` +
      `or:  bash scripts/web-e2e.sh <spec>`,
  );
}

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
  use: { baseURL: BASE_URL },
  projects: [
    // L2 layout-*: viewport 模拟, 只查响应式断点, e2e/layout/.
    {
      name: "layout-mobile-small",
      testDir: "./e2e/layout",
      use: { viewport: { width: 375, height: 667 }, hasTouch: true },
    },
    {
      name: "layout-mobile",
      testDir: "./e2e/layout",
      use: { viewport: { width: 390, height: 844 }, hasTouch: true },
    },
    {
      name: "layout-mobile-landscape",
      testDir: "./e2e/layout",
      use: { viewport: { width: 844, height: 390 }, hasTouch: true },
    },
    {
      name: "layout-desktop",
      testDir: "./e2e/layout",
      use: { viewport: { width: 1280, height: 800 } },
    },
    // L3 device-pc: 真桌面 Chromium, e2e/pc/.
    {
      name: "device-pc",
      testDir: "./e2e/pc",
      use: {},
    },
    // L4 device-mobile-android: 真 Android emu via CDP, e2e/mobile/.
    // 前置: scripts/test-mobile.sh 起 vite + adb forward + chrome 9222.
    {
      name: "device-mobile-android",
      testDir: "./e2e/mobile",
      use: {},
    },
  ],
});
