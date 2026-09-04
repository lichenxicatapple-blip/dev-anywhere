export interface StableVersion {
  major: number;
  minor: number;
  patch: number;
}

const STABLE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// 自动升级只接受 npm 正式版的精确三段版本。拒绝 tag、范围、预发布和额外参数，
// 这样 Relay 传来的值最终只能组成 @dev-anywhere/proxy@x.y.z。
export function parseStableVersion(value: string): StableVersion | null {
  const match = STABLE_VERSION_RE.exec(value);
  if (!match) return null;
  const version = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
  return Object.values(version).every(Number.isSafeInteger) ? version : null;
}

export function compareStableVersions(left: string, right: string): number | null {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  if (!a || !b) return null;
  if (a.major !== b.major) return Math.sign(a.major - b.major);
  if (a.minor !== b.minor) return Math.sign(a.minor - b.minor);
  return Math.sign(a.patch - b.patch);
}

export function selectHighestStableVersion(
  current: string | null,
  candidate: string,
): string | null {
  if (!parseStableVersion(candidate)) {
    return current && parseStableVersion(current) ? current : null;
  }
  if (!current || !parseStableVersion(current)) return candidate;
  return compareStableVersions(candidate, current) === 1 ? candidate : current;
}
