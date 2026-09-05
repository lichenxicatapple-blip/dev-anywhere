import { tryAcquireFileLock, type FileLock } from "#src/common/file-lock.js";
import { existsSync, writeFileSync } from "node:fs";

const path = process.argv[2];
if (!path || !process.send) throw new Error("Expected a lock path and an IPC channel");

let lock: FileLock | null = null;
process.on("message", (command) => {
  if (command === "acquire") {
    if (lock) throw new Error("Fixture already holds its lock");
    lock = tryAcquireFileLock(path);
    process.send?.(lock ? "acquired" : "unavailable");
  } else if (command === "release") {
    lock?.release();
    lock = null;
    process.send?.("released");
  } else if (command === "exit") {
    process.exit(0);
  } else if (command === "ping") {
    process.send?.("pong");
  } else if (command === "block") {
    if (!lock) throw new Error("Only a lock holder may block");
    const waiter = new Int32Array(new SharedArrayBuffer(4));
    const deadline = performance.now() + 5_000;
    writeFileSync(`${path}.blocked`, "blocked");
    // Block the actual owner thread on every OS. The parent releases this test-only gate;
    // the deadline prevents a failed assertion from leaving a stuck fixture behind.
    while (!existsSync(`${path}.resume`)) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error("Fixture was not unblocked by its parent");
      Atomics.wait(waiter, 0, 0, Math.min(remaining, 25));
    }
    process.send?.("unblocked");
  }
});
process.send("ready");
