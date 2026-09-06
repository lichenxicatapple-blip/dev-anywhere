import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMainThread } from "node:worker_threads";

// Plain JavaScript so the test can copy it to an isolated .mjs preload.
const tracePath = process.env.DA_LIFECYCLE_EXIT_TRACE;
const workerEntry = process.env.DA_LIFECYCLE_WORKER_ENTRY;
const profile = process.env.DA_LIFECYCLE_PROFILE;
const option = (name = "") => process.argv[process.argv.indexOf(name) + 1];
const samePath = (a = "", b = "") =>
  a &&
  b &&
  (process.platform === "win32"
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b));

// NODE_OPTIONS is inherited by the fixture's CLI, fake Agent and node-pty helpers too.
// Only its main terminal-worker process may be observed or have process.exit wrapped.
if (
  isMainThread &&
  tracePath &&
  samePath(process.argv[1], workerEntry) &&
  samePath(process.env.HOME, dirname(tracePath)) &&
  samePath(process.env.USERPROFILE, dirname(tracePath)) &&
  profile &&
  option("--profile") === profile &&
  process.argv.includes("--session") &&
  option("--session")
) {
  const sessionId = option("--session");
  const record = (stage = "", code = process.exitCode) => {
    try {
      appendFileSync(
        tracePath,
        `${JSON.stringify({ stage, pid: process.pid, sessionId, at: Date.now(), code })}\n`,
      );
    } catch {
      // Diagnostics must not change the worker's exit behavior if the file is unavailable.
    }
  };
  record("armed");
  const originalExit = process.exit;
  process.exit = (...args) => {
    record("process.exit", args[0] ?? process.exitCode);
    return originalExit.apply(process, args);
  };
  process.on("exit", (code) => record("exit", code));
  const originalReallyExit = Reflect.get(process, "reallyExit");
  if (typeof originalReallyExit === "function") {
    Reflect.set(
      process,
      "reallyExit",
      new Proxy(originalReallyExit, {
        apply(target, receiver, args) {
          record("reallyExit", args[0] ?? process.exitCode);
          return Reflect.apply(target, receiver, args);
        },
      }),
    );
  }
}
