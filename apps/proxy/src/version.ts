import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageInfo {
  name?: string;
  version?: string;
}

// 源码布局是 src/version.ts，发布布局是 dist/version chunk；两者的上一级都是
// @dev-anywhere/proxy 包根目录。集中读取后，CLI、daemon 与自动升级器共享同一个版本源。
export const PROXY_PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readProxyPackageInfo(): Required<Pick<PackageInfo, "name" | "version">> {
  const packageJsonPath = join(PROXY_PACKAGE_ROOT, "package.json");
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as PackageInfo;
  return {
    name: pkg.name ?? "@dev-anywhere/proxy",
    version: pkg.version ?? "unknown",
  };
}

const proxyPackageInfo = readProxyPackageInfo();

export const PROXY_PACKAGE_NAME = proxyPackageInfo.name;
export const PROXY_VERSION = proxyPackageInfo.version;
