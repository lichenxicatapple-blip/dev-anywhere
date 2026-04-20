// argv[2] 控制是否写 stderr: "stderr" | "quiet" | "partial"
// argv[3] 控制退出码: 默认 "0"
const mode = process.argv[2] ?? "quiet";
const exitCode = Number(process.argv[3] ?? "0");

if (mode === "stderr") {
  process.stderr.write("line one\n");
  process.stderr.write("line two\n");
} else if (mode === "partial") {
  // 最后一行故意不带 \n，测 helper 的 end-of-stream flush
  process.stderr.write("complete-line\n");
  process.stderr.write("trailing-no-newline");
}

process.exit(exitCode);
