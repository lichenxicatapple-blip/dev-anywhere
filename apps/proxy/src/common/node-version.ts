// Proxy 运行所需的最低 Node.js 版本。必须与 package.json 的 engines.node 保持一致
// （node-runtime.test.ts 会校验）。该模块只依赖语言内置能力，可在启动最早期安全加载。
export const MINIMUM_NODE_VERSION = "22.22.2";

/** 仅解析 `>=x[.y[.z]]` 形式的 engines.node；其他写法返回 null（无法判断，不阻止更新）。 */
export function nodeSatisfiesMinimum(range: string, nodeVersion: string): boolean | null {
  const match = /^>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
  const current = /^v?(\d+)\.(\d+)\.(\d+)/.exec(nodeVersion.trim());
  if (!match || !current) return null;
  const required = [match[1], match[2] ?? "0", match[3] ?? "0"].map(Number);
  const actual = [current[1], current[2], current[3]].map(Number);
  for (let index = 0; index < 3; index++) {
    const need = required[index] ?? 0;
    const have = actual[index] ?? 0;
    if (have !== need) return have > need;
  }
  return true;
}

/** 当前 Node.js 不满足最低版本时返回面向用户的提示，否则返回 null。 */
export function unsupportedNodeMessage(nodeVersion: string): string | null {
  if (nodeSatisfiesMinimum(`>=${MINIMUM_NODE_VERSION}`, nodeVersion) !== false) return null;
  return [
    `dev-anywhere requires Node.js ${MINIMUM_NODE_VERSION} or newer, but this process runs Node.js ${nodeVersion}.`,
    `Upgrade Node.js to ${MINIMUM_NODE_VERSION} or newer, then run the command again.`,
  ].join("\n");
}
