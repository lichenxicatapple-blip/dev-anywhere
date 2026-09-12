import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function isolatedCliEnvironment(home, inherited = process.env) {
  // os.homedir() uses USERPROFILE on Windows and HOME on POSIX.
  return { ...inherited, HOME: home, USERPROFILE: home };
}

async function runReleaseCliSmoke() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  // Keep Unix socket paths short even when macOS TMPDIR is deeply nested.
  const temporaryRoot = resolve(process.platform === "win32" ? tmpdir() : "/tmp");
  const prefix = "dev-anywhere-release-check.";
  const isolatedHome = mkdtempSync(join(temporaryRoot, prefix));
  const env = isolatedCliEnvironment(isolatedHome);
  const cli = join(root, "apps/proxy/dist/index.js");
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    if (result.error) throw result.error;
    assert.equal(
      result.status,
      0,
      `CLI ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
    return result.stdout;
  };
  let serviceStartAttempted = false;

  try {
    run("--version");
    process.stdout.write(run("init"));
    assert.match(run("serve", "status"), /^Service: not running\r?$/m);

    const appDir = join(isolatedHome, ".dev-anywhere");
    const config = JSON.parse(readFileSync(join(appDir, "config.json"), "utf8"));
    assert.equal(config.defaultProfile, "default");
    assert.equal(config.autoUpdate, true);
    assert.equal(config.profiles.default.relay, "cloud");
    assert.equal(config.relays.local.url, "ws://localhost:3100");
    assert.match(
      readFileSync(join(appDir, "relay-data/fonts/sarasa-fixed-sc/result.css"), "utf8"),
      /U\+2022/,
    );
    config.autoUpdate = false;
    config.relays.local.url = "ws://127.0.0.1:1";
    writeFileSync(join(appDir, "config.json"), JSON.stringify(config));
    const probe = createServer();
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    env.DEV_ANYWHERE_HOOK_PORT = String(probe.address().port);
    env.RELAY_URL = config.relays.local.url;
    await new Promise((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
    // Version/init/status do not load the PTY dependencies. Start the packaged
    // daemon too, so an import-time failure cannot pass the release smoke.
    serviceStartAttempted = true;
    run("serve", "start", "--relay", "local", "--json");
    assert.match(run("serve", "status"), /^Service: ready \(PID \d+\)\r?$/m);
    run("serve", "stop", "--json");
    serviceStartAttempted = false;
    assert.match(run("serve", "status"), /^Service: not running\r?$/m);
    console.log("release package smoke passed");
  } finally {
    if (serviceStartAttempted) run("serve", "stop", "--json");
    const target = resolve(isolatedHome);
    assert.equal(dirname(target), temporaryRoot, "cleanup must stay in the temporary directory");
    assert.ok(basename(target).startsWith(prefix), "cleanup must target this smoke's directory");
    rmSync(target, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runReleaseCliSmoke();
}
