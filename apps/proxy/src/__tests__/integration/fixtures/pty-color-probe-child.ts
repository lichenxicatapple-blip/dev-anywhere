// Plain JavaScript copied to .mjs by the native PTY test. Match a CLI's bounded startup probe:
// responses arriving after 250ms would otherwise become ordinary application input.
import { performance } from "node:perf_hooks";

process.stdin.setRawMode(true);
process.stdin.resume();
let received = "";
let stage = "probe";
const started = performance.now();
const fg = "\x1b]10;rgb:d4d4/d4d4/d4d4\x1b\\";
const bg = "\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\";
const deadline = setTimeout(() => finish("probe-timeout"), 250);
const lifetime = setTimeout(() => finish("input-timeout"), 8_000);

function finish(error = "") {
  clearTimeout(deadline);
  clearTimeout(lifetime);
  process.stdout.write(
    `PTY_COLOR_RESULT:${JSON.stringify({ error: error || null, received })}\r\n`,
  );
  process.stdin.setRawMode(false);
  process.exit(error ? 2 : 0);
}

process.stdin.on("data", (chunk) => {
  received += chunk.toString();
  if (stage === "probe" && received.includes(fg) && received.includes(bg)) {
    if (performance.now() - started >= 250) return finish("late-probe-response");
    clearTimeout(deadline);
    received = received.replace(fg, "").replace(bg, "");
    if (received) return finish("unexpected-probe-input");
    stage = "input";
    process.stdout.write(`PTY_COLOR_READY:${Math.ceil(performance.now() - started)}\r\n`);
  } else if (stage === "input" && received.includes("\r")) {
    if (received !== "user input\r") return finish("unexpected-user-input");
    finish();
  }
});

process.stdout.write("\x1b]10;?\x1b\\\x1b]11;?\x1b\\");
