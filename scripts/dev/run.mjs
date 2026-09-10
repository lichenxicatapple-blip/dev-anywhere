#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const [command, ...args] = process.argv.slice(2);
if (!["restart", "web", "health"].includes(command)) {
  console.error("Usage: node scripts/dev/run.mjs <restart|web|health> [options]");
  process.exitCode = 2;
} else if (process.platform === "win32") {
  const { main } = await import("./windows.mjs");
  await main(command, args).catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = error.exitCode ?? 1;
  });
} else {
  const child = spawn(
    "bash",
    [fileURLToPath(new URL(`./${command}.sh`, import.meta.url)), ...args],
    {
      stdio: "inherit",
    },
  );
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
