#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, openSync } from "node:fs";

const [cwd, logFile, command, ...args] = process.argv.slice(2);

if (!cwd || !logFile || !command) {
  console.error("Usage: start-detached.mjs <cwd> <log-file> <command> [args...]");
  process.exitCode = 2;
} else {
  try {
    const fd = openSync(logFile, "a");
    try {
      // Relay and Vite need no terminal. A separate process session also works
      // when launched from a macOS system service, where screen cannot detach.
      const child = spawn(command, args, {
        cwd,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", fd, fd],
      });
      await once(child, "spawn");
      child.unref();
      console.log(`Started background process (PID: ${child.pid})`);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    console.error(`Unable to start background process: ${error.message}`);
    process.exitCode = 1;
  }
}
