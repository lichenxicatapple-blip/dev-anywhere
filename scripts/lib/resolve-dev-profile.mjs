#!/usr/bin/env node
// 给本地 dev 脚本（dev-restart / dev-chaos / dev-health / mobile-smoke）解析当前
// ~/.dev-anywhere/config.json 中指向给定 relay URL 的 profile + relay 名字。
//
// 契约是 URL 匹配，不是名字。脚本先起本地 relay 在 ws://localhost:<port>，再用
// 这里解析出的 profile/relay 名字传给 proxy CLI。这样无论用户把 profile 改名
// 成什么（dev / playground / 张三 ...），脚本都不会因为找不到 "local" 而崩。
//
// stdout 输出两行 `KEY=value` 供调用方 eval；stderr 给人看的解释。
//
// Usage:
//   node scripts/lib/resolve-dev-profile.mjs --relay-url ws://localhost:3100
// Exit codes:
//   0  解析成功，stdout 有 PROFILE=... RELAY=...
//   2  config 不存在 / 没有匹配的 relay / 没有 profile 指向匹配的 relay

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function fail(msg) {
  process.stderr.write(`resolve-dev-profile: ${msg}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { relayUrl: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--relay-url") out.relayUrl = argv[++i];
    else if (a.startsWith("--relay-url=")) out.relayUrl = a.slice("--relay-url=".length);
  }
  if (!out.relayUrl) fail("missing required --relay-url <url>");
  return out;
}

// URL 比较：忽略尾部 `/`，scheme / host / port 严格相等。
function urlsEqual(a, b) {
  if (!a || !b) return false;
  const norm = (u) => u.replace(/\/+$/, "");
  return norm(a) === norm(b);
}

const { relayUrl } = parseArgs(process.argv.slice(2));
const configPath = join(homedir(), ".dev-anywhere", "config.json");

if (!existsSync(configPath)) {
  fail(`${configPath} does not exist; run \`dev-anywhere init\` first`);
}

let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf-8"));
} catch (err) {
  fail(`failed to parse ${configPath}: ${err.message}`);
}

const relays = config.relays ?? {};
const matchingRelayNames = Object.entries(relays)
  .filter(([, value]) => urlsEqual(value?.url, relayUrl))
  .map(([name]) => name);

if (matchingRelayNames.length === 0) {
  const available = Object.entries(relays)
    .map(([name, v]) => `  ${name}: ${v?.url ?? "(no url)"}`)
    .join("\n");
  fail(
    `no relay in ${configPath} has url=${relayUrl}\n` +
      `available relays:\n${available || "  (none)"}\n` +
      `add a relay pointing at ${relayUrl}, or pass --profile <name> --relay <name> explicitly.`,
  );
}

const relayName = matchingRelayNames.sort()[0];
if (matchingRelayNames.length > 1) {
  process.stderr.write(
    `resolve-dev-profile: ${matchingRelayNames.length} relays match ${relayUrl} (${matchingRelayNames.join(", ")}); picking "${relayName}".\n`,
  );
}

const profiles = config.profiles ?? {};
const matchingProfileNames = Object.entries(profiles)
  .filter(([, value]) => value?.relay === relayName)
  .map(([name]) => name);

if (matchingProfileNames.length === 0) {
  const available = Object.entries(profiles)
    .map(([name, v]) => `  ${name}: -> ${v?.relay ?? "(no relay)"}`)
    .join("\n");
  fail(
    `relay "${relayName}" exists but no profile points at it.\n` +
      `available profiles:\n${available || "  (none)"}\n` +
      `add a profile with \`"relay": "${relayName}"\`, or pass --profile <name> explicitly.`,
  );
}

const profileName = matchingProfileNames.sort()[0];
if (matchingProfileNames.length > 1) {
  process.stderr.write(
    `resolve-dev-profile: ${matchingProfileNames.length} profiles point at "${relayName}" (${matchingProfileNames.join(", ")}); picking "${profileName}".\n`,
  );
}

process.stdout.write(`RESOLVED_PROFILE=${profileName}\n`);
process.stdout.write(`RESOLVED_RELAY=${relayName}\n`);
