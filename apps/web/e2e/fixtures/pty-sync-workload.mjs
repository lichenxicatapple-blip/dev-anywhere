#!/usr/bin/env node

// Deterministic long-scrollback producer for the opt-in PTY sync benchmark. Every emitted row
// occupies 173 terminal cells and mixes realistic logs, code, JSON, diagnostics, ANSI styling,
// and CJK text. The deliberately varied content keeps a 5000-row xterm snapshot near 1.05 MB
// without giving compression an unrealistically repetitive all-padding workload.

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const seedLines = Number(args.get("--seed-lines") ?? 5000);
const fps = Number(args.get("--fps") ?? 38);
const token = args.get("--token") ?? "default";
const asciiColumns = 105;
const wideColumns = 34;
const seedWords = [
  "session",
  "snapshot",
  "request",
  "terminal",
  "renderer",
  "transport",
  "recovery",
  "workspace",
  "provider",
  "message",
  "buffer",
  "stream",
  "latency",
  "client",
  "proxy",
  "relay",
  "output",
  "sequence",
  "cursor",
  "artifact",
  "worker",
  "runtime",
  "handler",
  "connection",
  "pending",
  "approval",
  "command",
  "history",
  "project",
  "package",
  "typescript",
  "component",
];
const seedPaths = [
  "apps/web/src/lib/pty-session-transport.ts",
  "apps/relay/src/handlers/proxy.ts",
  "packages/shared/src/schemas/relay-control.ts",
  "src/components/chat/terminal-view.tsx",
  "node_modules/@xterm/xterm/lib/browser/Terminal.js",
  "/Users/dev/workspaces/acme-platform/services/api",
];
let seedState = 0x6d2b79f5;

if (!Number.isInteger(seedLines) || seedLines < 1) throw new Error("invalid --seed-lines");
if (!Number.isFinite(fps) || fps <= 0) throw new Error("invalid --fps");

function row(label) {
  const clipped = label.slice(0, asciiColumns);
  return `${clipped}${"a".repeat(asciiColumns - clipped.length)}${"终".repeat(wideColumns)}\r\n`;
}

function seedRandom() {
  seedState ^= seedState << 13;
  seedState ^= seedState >>> 17;
  seedState ^= seedState << 5;
  return seedState >>> 0;
}

function seedPick(values) {
  return values[seedRandom() % values.length];
}

function seedHex(length) {
  return Array.from({ length }, () => (seedRandom() & 15).toString(16)).join("");
}

function seedFiller(length) {
  let value = "";
  while (value.length < length) value += `${seedPick(seedWords)}_${seedHex(4)} `;
  return value.slice(0, length);
}

function fitSeedCells(value, targetCells = 173) {
  let cells = 0;
  let fitted = "";
  for (const char of value) {
    const width = /[\u3000-\u9fff]/.test(char) ? 2 : 1;
    if (cells + width > targetCells) break;
    fitted += char;
    cells += width;
  }
  if (cells < targetCells) fitted += seedFiller(targetCells - cells);
  return fitted;
}

function seedRow(index) {
  const shapes = [
    () =>
      `2026-08-21T12:${String(index % 60).padStart(2, "0")}:${String(seedRandom() % 60).padStart(2, "0")}.${String(seedRandom() % 1000).padStart(3, "0")}Z ${seedPick(["INFO", "WARN", "DEBUG", "ERROR"])} ${seedPick(seedWords)}.${seedPick(seedWords)} id=${seedHex(20)} ms=${seedRandom() % 5000} ${seedPick(seedPaths)}`,
    () =>
      `+ ${String(index).padStart(5)} const ${seedPick(seedWords)}_${(seedRandom() % 100000).toString(36)} = await ${seedPick(seedWords)}.${seedPick(["resolve", "subscribe", "flush", "apply"])}({ requestId: '${seedHex(16)}', outputSeq: ${seedRandom() % 1000000} });`,
    () =>
      `{"ts":${1700000000000 + (seedRandom() % 100000000)},"level":"${seedPick(["info", "warn", "debug", "error"])}","sessionId":"${seedHex(21)}","component":"${seedPick(seedWords)}","message":"${seedFiller(50)}"}`,
    () =>
      `${seedPick(seedPaths)}:${1 + (seedRandom() % 900)}: ${seedPick(["error TS2345", "warning", "PASS", "FAIL", "changed"])} ${seedPick(seedWords)}_${seedHex(8)} ${seedFiller(55)} sha=${seedHex(24)}`,
    () =>
      `用户终端同步恢复状态 ${seedFiller(75)} trace=${seedHex(32)} seq=${seedRandom() % 1000000} status=${seedPick(["completed", "pending", "streaming"])}`,
  ];
  const content = fitSeedCells(`${shapes[index % shapes.length]()} 终端同步恢复完成日志`);
  const color = index % 7;
  if (index % 5 >= 3) return `\x1b[3${color}m${content}\x1b[0m\r\n`;
  const cut = Math.floor(content.length / 2);
  return `\x1b[3${color}m${content.slice(0, cut)}\x1b[1;3${(index + 3) % 7}m${content.slice(cut)}\x1b[0m\r\n`;
}

async function write(chunk) {
  if (process.stdout.write(chunk)) return;
  await new Promise((resolve) => process.stdout.once("drain", resolve));
}

for (let start = 0; start < seedLines; start += 100) {
  const end = Math.min(seedLines, start + 100);
  let batch = "";
  for (let index = start; index < end; index += 1) {
    batch += seedRow(index);
  }
  await write(batch);
}
await write(row(`__PTY_SYNC_SEED_READY_${token}__`));

let frame = 0;
const intervalMs = 1000 / fps;
let nextFrameAt = performance.now() + intervalMs;
let timer;

function scheduleFrame() {
  const delay = Math.max(0, nextFrameAt - performance.now());
  timer = setTimeout(() => {
    frame += 1;
    process.stdout.write(row(`__PTY_SYNC_FRAME_${String(frame).padStart(8, "0")}__`));
    nextFrameAt += intervalMs;
    scheduleFrame();
  }, delay);
}
scheduleFrame();

process.stdin.setEncoding("utf8");
if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
  process.stdin.setRawMode(true);
}
process.stdin.resume();

let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
  const commands = input.split(/[\r\n]+/);
  input = commands.pop() ?? "";
  for (const command of commands) {
    const match = /^watermark\s+([A-Za-z0-9_-]+)$/.exec(command.trim());
    if (match) process.stdout.write(row(`__PTY_SYNC_WATERMARK_${match[1]}__`));
  }
});

function stop() {
  clearTimeout(timer);
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
