import { defineConfig } from "tsup";

// index.js 作为 bin 需要 shebang; server.js 仅作为 import 目标, 多出一行 shebang 不影响 ESM import
// noExternal @cc-anywhere/shared: 发 npm 时 shared 不对外单独发, inline 让 relay 自包含
export default defineConfig({
  entry: ["src/index.ts", "src/server.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  target: "node20",
  noExternal: ["@cc-anywhere/shared"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
