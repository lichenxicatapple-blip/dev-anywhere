import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });
const deadline = setTimeout(() => process.exit(2), 30_000);
input.on("line", (line) => {
  if (line === "ping") process.stdout.write(`FAKE_AGENT_PONG:${process.pid}\n`);
  if (line === "exit") {
    clearTimeout(deadline);
    process.exit(0);
  }
});
process.stdout.write(`FAKE_AGENT_READY:${process.pid}\n`);
