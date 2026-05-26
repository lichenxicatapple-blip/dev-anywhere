export type ProcessProbeStatus = "alive" | "not-found" | "permission-denied" | "unknown";

export type ProcessProbeResult =
  | { status: "alive" }
  | { status: "not-found"; code: "ESRCH"; message: string }
  | { status: "permission-denied"; code: "EPERM"; message: string }
  | { status: "unknown"; code?: string; message: string };

export function getErrnoCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as NodeJS.ErrnoException).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function probeProcess(pid: number): ProcessProbeResult {
  try {
    process.kill(pid, 0);
    return { status: "alive" };
  } catch (err) {
    const code = getErrnoCode(err);
    const message = getErrorMessage(err);
    if (code === "ESRCH") return { status: "not-found", code, message };
    if (code === "EPERM") return { status: "permission-denied", code, message };
    return { status: "unknown", code, message };
  }
}

export function processExistsOrIsInaccessible(pid: number): boolean {
  const probe = probeProcess(pid);
  return probe.status === "alive" || probe.status === "permission-denied";
}
