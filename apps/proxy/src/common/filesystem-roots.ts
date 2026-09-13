import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { platform } from "node:os";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { FileSystemRoot } from "@dev-anywhere/shared";

const execFileAsync = promisify(execFile);

function uniqueRoots(roots: FileSystemRoot[]): FileSystemRoot[] {
  return [...new Map(roots.map((root) => [root.path, root])).values()];
}

// mountinfo escapes spaces, tabs, newlines and backslashes as octal sequences.
function decodeMountPath(path: string): string {
  return path.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

export function linuxMountRoots(mountinfo: string): FileSystemRoot[] {
  const roots: FileSystemRoot[] = [{ name: "/", path: "/" }];
  for (const line of mountinfo.split("\n")) {
    const [mount, filesystem] = line.split(" - ");
    if (!mount || !filesystem) continue;
    const fields = mount.split(" ");
    const [type, source] = filesystem.split(" ");
    const path = decodeMountPath(fields[4] ?? "");
    const mountRoot = decodeMountPath(fields[3] ?? "");
    if (!path.startsWith("/") || path === "/") continue;
    const userMount = /^\/(?:mnt|media|run\/media)(?:\/|$)/.test(path);
    const volume = source?.startsWith("/dev/") && mountRoot === "/";
    const network = /^(?:nfs\d*|cifs|smb3?|fuse\..+)$/.test(type ?? "");
    if (userMount || volume || network) roots.push({ name: basename(path), path });
  }
  return uniqueRoots(roots);
}

export async function listFileSystemRoots(): Promise<FileSystemRoot[]> {
  if (platform() === "win32") {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ConvertTo-Json -InputObject @([System.IO.Directory]::GetLogicalDrives()) -Compress",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 },
    );
    const paths: unknown = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
    if (
      !Array.isArray(paths) ||
      paths.some((path) => typeof path !== "string" || !/^[a-z]:\\$/i.test(path))
    ) {
      throw new Error("Invalid logical drive list");
    }
    return uniqueRoots(paths.sort().map((path: string) => ({ name: path, path })));
  }
  if (platform() === "darwin") {
    const volumes = await readdir("/Volumes", { withFileTypes: true });
    return [
      { name: "/", path: "/" },
      ...volumes
        .filter(
          (volume) =>
            !volume.name.startsWith(".") && (volume.isDirectory() || volume.isSymbolicLink()),
        )
        .map((volume) => ({ name: volume.name, path: `/Volumes/${volume.name}` })),
    ];
  }
  if (platform() === "linux") {
    return linuxMountRoots(await readFile("/proc/self/mountinfo", "utf8"));
  }
  return [{ name: "/", path: "/" }];
}
