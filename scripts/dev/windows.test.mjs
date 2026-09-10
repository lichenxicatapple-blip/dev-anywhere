import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  findServiceLog,
  normalizeTarget,
  ownsProcess,
  parseArgs,
  portAvailable,
} from "./windows.mjs";

const exec = promisify(execFile);

test("restart preserves argv with spaces and explicit overrides", () => {
  const options = parseArgs("restart", [
    "--",
    "--profile",
    "local-test",
    "--relay=local relay",
    "--log-dir",
    "C:\\my logs\\dev",
    "--relay-port=3101",
    "--web-port",
    "5174",
    "--log-retention=0",
  ]);
  assert.equal(options.profile, "local-test");
  assert.equal(options.relay, "local relay");
  assert.equal(options["log-dir"], "C:\\my logs\\dev");
  assert.equal(options["relay-port"], "3101");
  assert.equal(options["web-port"], "5174");
  assert.equal(options["log-retention"], "0");
  assert.equal(parseArgs("restart", []).profile, undefined);
});

test("invalid arguments fail before any process starts", () => {
  for (const args of [
    ["--profile"],
    ["--profile="],
    ["--profile", "--web-port=5174"],
    ["--web-port=65536"],
    ["--relay-port=0"],
    ["--web-port=nope"],
    ["--log-retention=-1"],
    ["--relay-port=5173"],
    ["--relay-port=03100", "--web-port=3100"],
    ["--unexpected"],
  ]) {
    assert.throws(() => parseArgs("restart", args), { exitCode: 2 });
  }
  assert.throws(
    () => parseArgs("web", ["--relay=local", "--target=http://localhost:3100", "--port=5173"]),
    { exitCode: 2 },
  );
  assert.throws(() => parseArgs("web", ["--port=5173"]), { exitCode: 2 });
  assert.throws(() => parseArgs("web", ["--relay=local"]), { exitCode: 2 });
});

test("web accepts WebSocket URLs and validates protocols", () => {
  assert.equal(normalizeTarget("ws://localhost:3100/"), "http://localhost:3100");
  assert.equal(normalizeTarget("wss://relay.example/prefix/"), "https://relay.example/prefix");
  assert.throws(() => normalizeTarget("file:///C:/relay"), { exitCode: 2 });
  assert.throws(() => normalizeTarget("not a URL"), { exitCode: 2 });
});

test("a reused PID cannot authorize stopping an unrelated process", () => {
  const record = { pid: 123, token: "dev-anywhere-12345678-1234-1234-1234-123456789abc" };
  assert.ok(
    ownsProcess(
      record,
      `"C:\\Program Files\\nodejs\\node.exe" --title=${record.token} "C:\\workspace with spaces\\vite.js"`,
    ),
  );
  assert.ok(!ownsProcess(record, "node.exe unrelated-server.js"));
  assert.ok(!ownsProcess({ ...record, token: "" }, "node.exe --title="));
  assert.ok(
    !ownsProcess({ ...record, pid: "123; Stop-Process" }, `node.exe --title=${record.token}`),
  );
});

test("port probe leaves another listener running", async () => {
  const listener = net.createServer();
  await new Promise((resolveListen) => listener.listen(0, "127.0.0.1", resolveListen));
  const port = listener.address().port;
  try {
    assert.equal(await portAvailable(port, "127.0.0.1"), false);
    assert.equal(listener.listening, true);
  } finally {
    await new Promise((resolveClose) => listener.close(resolveClose));
  }
  assert.equal(await portAvailable(port, "127.0.0.1"), true);
});

test("profile resolver JSON preserves renamed profiles and relay names", async () => {
  const home = await mkdtemp(join(tmpdir(), "dev-anywhere-profile-"));
  try {
    await mkdir(join(home, ".dev-anywhere"));
    await writeFile(
      join(home, ".dev-anywhere/config.json"),
      JSON.stringify({
        relays: {
          "local relay": { url: "ws://localhost:3100/" },
          cloud: { url: "wss://example.com" },
        },
        profiles: { "my-dev-profile": { relay: "local relay" }, default: { relay: "cloud" } },
      }),
    );
    const { stdout } = await exec(
      process.execPath,
      [
        fileURLToPath(new URL("../lib/resolve-dev-profile.mjs", import.meta.url)),
        "--relay-url",
        "ws://localhost:3100",
        "--json",
      ],
      {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        windowsHide: true,
      },
    );
    assert.deepEqual(JSON.parse(stdout), { profile: "my-dev-profile", relay: "local relay" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("service log selection prefers stable path, current active lease, then latest run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dev-anywhere-log-"));
  const stable = join(dir, "service.log");
  const active = join(dir, "service-active.log");
  const latest = join(dir, "service-latest.log");
  try {
    assert.equal(await findServiceLog(dir, 123), stable);
    await writeFile(active, "current service");
    await writeFile(latest, "newer command log");
    await utimes(active, 1, 1);
    await utimes(latest, 2, 2);
    assert.equal(await findServiceLog(dir, 123), latest);
    await writeFile(
      `${active}.active`,
      JSON.stringify({ version: 1, pid: 123, fileName: "service-active.log" }),
    );
    assert.equal(await findServiceLog(dir, 123), active);
    assert.equal(await findServiceLog(dir, 456), latest);
    await writeFile(stable, "stable log");
    assert.equal(await findServiceLog(dir, 123), stable);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
