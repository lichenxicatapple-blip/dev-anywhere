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
  testDir: "./e2e",
  timeout: 30000,
  use: {
    baseURL: BASE_URL,
  },
  projects: [
    // 小屏手机覆盖旧 iPhone / SE 类尺寸，防止只在大手机上通过。
    {
      name: "mobile-small",
      use: { viewport: { width: 375, height: 667 }, hasTouch: true },
    },
    // 标准手机视口覆盖抽屉、软键盘和窄屏滚动路径。
    {
      name: "mobile",
      use: { viewport: { width: 390, height: 844 }, hasTouch: true },
    },
    // 手机横屏覆盖 PTY、输入栏和弹层在低高度下的布局。
    {
      name: "mobile-landscape",
      use: { viewport: { width: 844, height: 390 }, hasTouch: true },
    },
    // 桌面视口覆盖 master-detail、侧栏和宽屏终端路径。
    {
      name: "desktop",
      use: { viewport: { width: 1280, height: 800 } },
    },
  ],
});
