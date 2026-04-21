#!/usr/bin/env node
// 采样 Claude CLI stream-json 原始事件流，落成 fixture 供后续 schema drift 回归测试
// 用法: pnpm --filter @lichenxi.cat/cc-anywhere exec tsx scripts/sample-stream-json.ts
// 前置: 本机已安装并登录 claude CLI (CLAUDE_BIN 可覆盖二进制路径)

import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 脚本相对位置，避免 cwd 不稳定（pnpm --filter 下 cwd 是 app root）
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROXY_ROOT = dirname(SCRIPT_DIR);
const FIXTURES_BASE = join(PROXY_ROOT, "src/__tests__/fixtures/stream-json");

// 构建 scrub 规则：按长度降序排，避免短子串先吞掉长字符串（比如 $HOME 要在 username 前）
// stream-json 的 system/init 事件会包含 plugins 路径、hostname、git email 等本机信息，
// fixture 进 public repo 前必须抹掉这些。
function buildScrubRules(cwd: string): Array<[string, string]> {
  const rules: Array<[string, string]> = [];
  const safe = (cmd: string): string | null => {
    try {
      return (
        execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
          .toString()
          .trim() || null
      );
    } catch {
      return null;
    }
  };

  if (cwd) {
    rules.push([cwd, "<CWD>"]);
    // Claude 把 cwd 做 / → - 变换作 ~/.claude/projects 目录名
    rules.push([cwd.replace(/\//g, "-"), "<CWD_ENCODED>"]);
  }
  const home = process.env.HOME;
  if (home && home !== cwd) {
    rules.push([home, "<HOME>"]);
    rules.push([home.replace(/\//g, "-"), "<HOME_ENCODED>"]);
  }
  const hostname = safe("hostname");
  if (hostname) rules.push([hostname, "<HOST>"]);
  const computerName = safe("scutil --get ComputerName");
  if (computerName && computerName !== hostname) rules.push([computerName, "<HOST>"]);
  const email = safe("git config --global user.email");
  if (email) rules.push([email, "<EMAIL>"]);
  const gitName = safe("git config --global user.name");
  if (gitName) rules.push([gitName, "<USER>"]);
  const osUser = process.env.USER;
  if (osUser && osUser !== gitName) rules.push([osUser, "<USER>"]);

  rules.sort((a, b) => b[0].length - a[0].length);
  return rules;
}

function scrub(line: string, rules: Array<[string, string]>): string {
  let out = line;
  for (const [needle, placeholder] of rules) {
    out = out.split(needle).join(placeholder);
  }
  return out;
}

interface Scenario {
  name: string;
  model: string;
  prompt: string;
  // 开启 --include-partial-messages，采样 stream_event.content_block_delta 形式的增量事件
  includePartialMessages?: boolean;
  // 覆盖 permission-mode。不填默认 bypassPermissions，跳过审批流（用于非审批类采样）。
  // control-request scenario 需要 "default" 触发真实审批，脚本侧 auto-approver 自动回 allow。
  permissionMode?: "default" | "bypassPermissions" | "acceptEdits" | "plan";
}

// 不同 scenario 用不同模型以覆盖 thinking 能力差异
const SCENARIOS: Scenario[] = [
  {
    name: "text-only",
    model: "claude-sonnet-4-6",
    prompt: "What is 1 + 1? Reply with only the number, no other text.",
  },
  {
    name: "tool-use",
    model: "claude-sonnet-4-6",
    prompt:
      'Use the Read tool on the "package.json" file in the current directory, then tell me the "name" field exactly.',
  },
  {
    name: "thinking",
    model: "claude-opus-4-7",
    prompt:
      "Think step by step: how many distinct letters are in the word MISSISSIPPI? Show your reasoning process, then give the answer.",
  },
  {
    name: "thinking-plain",
    model: "claude-haiku-4-5-20251001",
    prompt:
      "Think step by step: how many distinct letters are in MISSISSIPPI? Show your reasoning, then give the answer.",
  },
  // stream delta 开：验证 stream_event / content_block_delta / text_delta 真实 shape
  {
    name: "stream-delta",
    model: "claude-sonnet-4-6",
    prompt: "List the first 5 Fibonacci numbers one per line.",
    includePartialMessages: true,
  },
  // 非 bypass 模式下走完整审批流：claude 发 control_request，脚本 auto-approver 自动回 allow。
  // 覆盖 forwardApprovalRequest / handleControlRequest 这条路径的真实 wire shape。
  // Write 工具在 default 模式下必定走审批（不会被本地 allowlist 豁免），落地的文件由脚本清理。
  {
    name: "control-request",
    model: "claude-sonnet-4-6",
    prompt:
      'Use the Write tool to create a file at "/tmp/cc-anywhere-canary.txt" with content "canary". Just do it, no other output.',
    permissionMode: "default",
  },
];

async function runScenario(
  scenario: Scenario,
  outDir: string,
  cwd: string,
  scrubRules: Array<[string, string]>,
): Promise<void> {
  const outFile = join(outDir, `${scenario.name}.jsonl`);
  console.log(`\n[${scenario.name}] model=${scenario.model}`);

  const claudeBin = process.env.CLAUDE_BIN ?? "claude";
  const permissionMode = scenario.permissionMode ?? "bypassPermissions";
  const args = [
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--permission-prompt-tool",
    "stdio",
    "--permission-mode",
    permissionMode,
    "--verbose",
    "--fork-session",
    "--model",
    scenario.model,
  ];
  if (scenario.includePartialMessages) args.push("--include-partial-messages");

  const child = spawn(claudeBin, args, { stdio: ["pipe", "pipe", "pipe"], cwd });

  const lines: string[] = [];
  let buf = "";
  let timeoutHandle: NodeJS.Timeout | null = null;

  return new Promise((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const scrubbed = scrub(line, scrubRules);
        lines.push(scrubbed);
        try {
          const event = JSON.parse(line) as {
            type?: string;
            request_id?: string;
            request?: { subtype?: string };
          };
          // auto-approver: 收到 control_request 自动回 allow，保证采样不卡住。
          // 采样的是 wire shape，不是审批逻辑，所以 allow 是唯一合理选择。
          if (event.type === "control_request" && event.request?.subtype === "can_use_tool") {
            const response = {
              type: "control_response",
              response: {
                subtype: "success",
                request_id: event.request_id,
                response: { behavior: "allow", updatedInput: {} },
              },
            };
            const respJson = JSON.stringify(response);
            console.log(`[${scenario.name}] auto-approve control_request ${event.request_id}`);
            child.stdin?.write(respJson + "\n");
            // 审批回应本身也作为 fixture 的一部分保留，下游测试能验证 response shape
            lines.push(scrub(respJson, scrubRules));
          }
          if (event.type === "result") {
            console.log(`[${scenario.name}] result received, closing stdin`);
            child.stdin?.end();
          }
        } catch {
          // 非 JSON 行（不应发生，stream-json 每行都是 JSON）忽略
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[${scenario.name}][stderr] ${chunk}`);
    });

    child.on("exit", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      writeFileSync(outFile, lines.join("\n") + (lines.length ? "\n" : ""), "utf-8");
      console.log(`[${scenario.name}] exit=${code}, events=${lines.length}, out=${outFile}`);
      resolve();
    });

    child.on("error", (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(err);
    });

    // 120s 超时兜底：模型不返回 result 时避免脚本永挂
    timeoutHandle = setTimeout(() => {
      console.warn(`[${scenario.name}] timeout, killing`);
      child.kill("SIGTERM");
    }, 120_000);

    // 发送 user message
    const userMsg = {
      type: "user",
      message: { role: "user", content: scenario.prompt },
    };
    child.stdin?.write(JSON.stringify(userMsg) + "\n");
  });
}

async function main(): Promise<void> {
  const claudeBin = process.env.CLAUDE_BIN ?? "claude";
  let version = "unknown";
  try {
    const raw = execSync(`${claudeBin} --version`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const match = raw.match(/(\d+\.\d+\.\d+)/);
    if (match) version = match[1];
  } catch (err) {
    console.error("Failed to detect claude version:", err);
    process.exit(1);
  }

  const outDir = join(FIXTURES_BASE, `claude-${version}`);
  mkdirSync(outDir, { recursive: true });
  console.log(`Claude CLI version: ${version}`);
  console.log(`Output dir: ${outDir}`);

  const cwd = process.cwd();
  const scrubRules = buildScrubRules(cwd);
  console.log(`Scrub rules: ${scrubRules.map(([k, v]) => `${k} → ${v}`).join(", ")}`);

  for (const scenario of SCENARIOS) {
    try {
      await runScenario(scenario, outDir, cwd, scrubRules);
    } catch (err) {
      console.error(`[${scenario.name}] failed:`, err);
    }
  }
}

main();
