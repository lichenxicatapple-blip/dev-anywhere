export function isScpLikeRemotePath(path: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return false;

  const separator = path.indexOf(":");
  if (separator <= 0) return false;

  const authority = path.slice(0, separator);
  const remotePath = path.slice(separator + 1);
  if (!remotePath.includes("/")) return false;
  if (!/^[A-Za-z0-9._~-]+(?:@[A-Za-z0-9.-]+)?$/.test(authority)) return false;

  const host = authority.includes("@")
    ? authority.slice(authority.lastIndexOf("@") + 1)
    : authority;
  if (!host.includes(".")) return false;

  return /^[A-Za-z0-9._~%+-]+(?:\/[A-Za-z0-9._~%+-]+)+$/.test(remotePath);
}
