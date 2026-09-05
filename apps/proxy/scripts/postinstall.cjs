// node-pty's macOS spawn helper must retain executable permissions after package extraction.
// Other platforms need no shell command or chmod step.
if (process.platform === "darwin") {
  const { chmodSync, readdirSync, statSync } = require("node:fs");
  const { dirname, join } = require("node:path");
  try {
    const prebuilds = join(dirname(require.resolve("node-pty/package.json")), "prebuilds");
    for (const entry of readdirSync(prebuilds)) {
      if (!entry.startsWith("darwin-")) continue;
      const helper = join(prebuilds, entry, "spawn-helper");
      try {
        chmodSync(helper, statSync(helper).mode | 0o111);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "MODULE_NOT_FOUND") {
      console.warn(`Could not prepare node-pty spawn helper: ${error.message}`);
    }
  }
}
