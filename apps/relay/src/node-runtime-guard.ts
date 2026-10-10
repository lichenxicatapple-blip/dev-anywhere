// 副作用模块：必须是入口文件的第一个 import，在加载其他依赖前检查 Node.js 版本。
// 最低版本必须与 package.json 的 engines.node 保持一致（node-runtime-guard.test.ts 会校验）。
export const MINIMUM_NODE_VERSION = "22.22.2";

export function isSupportedNodeVersion(nodeVersion: string): boolean {
  const current = /^v?(\d+)\.(\d+)\.(\d+)/.exec(nodeVersion.trim());
  if (!current) return true;
  const required = MINIMUM_NODE_VERSION.split(".").map(Number);
  const actual = [current[1], current[2], current[3]].map(Number);
  for (let index = 0; index < 3; index++) {
    const need = required[index] ?? 0;
    const have = actual[index] ?? 0;
    if (have !== need) return have > need;
  }
  return true;
}

export function unsupportedNodeMessage(nodeVersion: string): string | null {
  if (isSupportedNodeVersion(nodeVersion)) return null;
  return [
    `dev-anywhere-relay requires Node.js ${MINIMUM_NODE_VERSION} or newer, but this process runs Node.js ${nodeVersion}.`,
    `Upgrade Node.js to ${MINIMUM_NODE_VERSION} or newer, then start the Relay again.`,
  ].join("\n");
}

const unsupported = unsupportedNodeMessage(process.versions.node);
if (unsupported) {
  process.stderr.write(`${unsupported}\n`);
  process.exit(1);
}
