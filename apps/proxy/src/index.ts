import { PtyManager } from "./pty-manager.js";
import { createNoopTap } from "./tap.js";

// 所有命令行参数直接透传给 claude
const claudeArgs = process.argv.slice(2);

const manager = new PtyManager({
  claudeArgs,
  tap: createNoopTap(),
  stdin: process.stdin,
  stdout: process.stdout,
});

manager.start();
