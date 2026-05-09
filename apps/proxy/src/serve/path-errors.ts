import { ControlErrorCode } from "@dev-anywhere/shared";

function getFsErrorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

export function classifyPathError(err: unknown): ControlErrorCode {
  switch (getFsErrorCode(err)) {
    case "ENOENT":
      return ControlErrorCode.PATH_NOT_FOUND;
    case "ENOTDIR":
      return ControlErrorCode.PATH_NOT_DIRECTORY;
    case "EACCES":
    case "EPERM":
      return ControlErrorCode.PATH_ACCESS_DENIED;
    default:
      return ControlErrorCode.UNKNOWN;
  }
}
