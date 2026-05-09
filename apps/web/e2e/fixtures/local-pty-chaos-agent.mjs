#!/usr/bin/env node

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();

process.stdout.write("\x1b]0;DEV Anywhere Local PTY\x07");
process.stdout.write("DEV Anywhere local PTY ready\r\n");

let buffer = "";

process.stdin.on("data", (chunk) => {
  const data = chunk.toString("utf8");
  for (const ch of data) {
    if (ch === "\r" || ch === "\n") {
      process.stdout.write("\r\n");
      if (buffer.includes("exit-chaos")) {
        process.stdout.write("local PTY chaos provider exiting now\r\n");
        process.exit(0);
      }
      if (buffer.length > 0) {
        process.stdout.write(`received: ${buffer}\r\n`);
      }
      buffer = "";
      continue;
    }

    if (ch === "\u0003") {
      process.stdout.write("^C\r\n");
      buffer = "";
      continue;
    }

    buffer += ch;
    process.stdout.write(ch);
  }
});
