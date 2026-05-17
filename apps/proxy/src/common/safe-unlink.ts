import { unlinkSync } from "node:fs";

type UnlinkFn = (path: string) => void;

export function unlinkIfPresent(path: string, unlink: UnlinkFn = unlinkSync): void {
  try {
    unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}
