import { defineConfig } from "tsup";

// noExternal @dev-anywhere/shared: 发 npm 时 shared 是 workspace-only 包, 不对外单独发,
// 所以 inline 进 dist 让 dev-anywhere 成为 self-contained 可独立安装的包
// node-pty 是 native addon, 保留 external 让 npm install 时走 prebuild / node-gyp
export default defineConfig({
  entry: ["src/index.ts", "src/serve.ts", "src/session-worker.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  target: "node20",
  noExternal: ["@dev-anywhere/shared"],
  // 构建期将 process.env.NODE_ENV 替换为 "production"，
  // 让 src/common/env.ts 里的 IS_DEV 静态折叠为 false，dev 分支被 DCE 删除。
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
});
