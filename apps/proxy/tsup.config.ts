import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/serve.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
