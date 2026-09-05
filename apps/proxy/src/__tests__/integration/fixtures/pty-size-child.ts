import { createInterface } from "node:readline";

// Kept as plain JavaScript so the test can copy this fixture to an isolated .mjs file.
// Match interactive CLI input, including Windows resize notifications through raw TTY reads.
process.stdin.setRawMode(true);
const input = createInterface({ input: process.stdin });
const deadline = setTimeout(() => process.exit(2), 20_000);

function report(content = "ready") {
  const [columns, rows] = process.stdout.getWindowSize();
  process.stdout.write(`PTY_PROBE:${JSON.stringify([content, columns, rows])}\n`);
}

input.on("line", (line) => {
  if (line.startsWith("probe ")) report(line.slice(6));
  if (line === "exit") {
    clearTimeout(deadline);
    process.stdin.setRawMode(false);
    process.exit(0);
  }
});

report();
