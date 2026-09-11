import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL("../lib/start-detached.mjs", import.meta.url));

async function waitFor(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(20);
  }
  assert.fail("Detached process did not reach the expected state within 3 seconds");
}

test("background service survives its launcher with no terminal and preserves args and logs", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "dev-anywhere detached "));
  const log = join(cwd, "service output.log");
  const ready = join(cwd, "ready.json");
  const fixture = join(cwd, "http service.mjs");
  t.after(async () => {
    let info;
    try {
      info = JSON.parse(await readFile(ready, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (info) {
      try {
        process.kill(info.pid);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      await waitFor(() => {
        try {
          process.kill(info.pid, 0);
          return false;
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
          return true;
        }
      });
    }
    await rm(cwd, { recursive: true, force: true });
  });
  await writeFile(
    fixture,
    `import http from "node:http";
import { writeFileSync } from "node:fs";
const server = http.createServer((request, response) => response.end("still running"));
server.listen(0, "127.0.0.1", () => {
  console.log("stdout ready");
  console.error("stderr ready");
  writeFileSync(process.argv[2], JSON.stringify({
    pid: process.pid, port: server.address().port, cwd: process.cwd(),
    argument: process.argv[3], inherited: process.env.DEV_ANYWHERE_DETACHED_TEST,
    stdinTTY: Boolean(process.stdin.isTTY), stdoutTTY: Boolean(process.stdout.isTTY)
  }));
});
setTimeout(() => process.exit(1), 15000).unref();
`,
  );
  const argument = 'spaces and literal $HOME $(echo nope) "quotes"';
  const { stdout } = await exec(
    process.execPath,
    [launcher, cwd, log, process.execPath, fixture, ready, argument],
    { timeout: 5000, env: { ...process.env, DEV_ANYWHERE_DETACHED_TEST: "inherited" } },
  );
  // execFile has finished: subsequent HTTP requests are served after the launcher exited.
  const info = await waitFor(async () => {
    try {
      return JSON.parse(await readFile(ready, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return null;
    }
  });
  assert.match(stdout, new RegExp(`PID: ${info.pid}\\b`));
  assert.equal(await realpath(info.cwd), await realpath(cwd));
  assert.equal(info.argument, argument);
  assert.equal(info.inherited, "inherited");
  assert.equal(info.stdinTTY, false);
  assert.equal(info.stdoutTTY, false);
  const response = await fetch(`http://127.0.0.1:${info.port}/`, {
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(await response.text(), "still running");
  const output = await readFile(log, "utf8");
  assert.match(output, /stdout ready/);
  assert.match(output, /stderr ready/);
});

test("background launch reports a missing executable immediately", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "dev-anywhere-detached-error-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await assert.rejects(
    exec(process.execPath, [launcher, cwd, join(cwd, "output.log"), join(cwd, "missing")], {
      timeout: 3000,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Unable to start background process: .*ENOENT/);
      assert.doesNotMatch(error.stdout, /Started background process/);
      return true;
    },
  );
});
