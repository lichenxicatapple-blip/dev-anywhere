import { createInterface } from "node:readline";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const input = createInterface({ input: process.stdin });
const journalPath = process.env.DA_LIFECYCLE_AGENT_JOURNAL;
const controlPath = process.env.DA_LIFECYCLE_AGENT_CONTROL;
const deadline = setTimeout(() => process.exit(2), journalPath ? 90_000 : 30_000);
let offlineSequence = 0;

function report(line = "") {
  process.stdout.write(`${line}\n`, () => {
    // Record only completed stdout writes, so offline progress cannot be mistaken for
    // a live process whose terminal output is blocked on the disconnected Proxy.
    if (journalPath) appendFileSync(journalPath, `${line}\n`);
  });
}

function exit() {
  clearTimeout(deadline);
  process.exit(0);
}

if (controlPath) {
  setInterval(() => {
    if (!existsSync(controlPath)) return;
    const command = readFileSync(controlPath, "utf8").trim();
    if (command === "exit") exit();
    if (command === "offline") report(`FAKE_AGENT_OFFLINE:${process.pid}:${++offlineSequence}`);
  }, 50);
}

input.on("line", (line) => {
  if (line === "ping") report(`FAKE_AGENT_PONG:${process.pid}`);
  if (line === "exit") exit();
});
report(`FAKE_AGENT_READY:${process.pid}`);
