import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import { linuxMountRoots, listFileSystemRoots } from "#src/common/filesystem-roots.js";

describe("filesystem roots", () => {
  it("lists this machine's roots as absolute paths", async () => {
    const roots = await listFileSystemRoots();
    expect(roots.length).toBeGreaterThan(0);
    expect(roots.every((root) => isAbsolute(root.path))).toBe(true);
    expect(new Set(roots.map((root) => root.path)).size).toBe(roots.length);
    if (process.platform === "win32") {
      expect(
        roots.some(
          (root) =>
            root.path.toLowerCase() === `${process.env.SystemDrive ?? "C:"}\\`.toLowerCase(),
        ),
      ).toBe(true);
    } else {
      expect(roots).toContainEqual({ name: "/", path: "/" });
    }
  });

  it("includes mounted disks and shares, decodes paths, and omits pseudo filesystems and file binds", () => {
    const roots = linuxMountRoots(
      [
        "1 0 8:1 / / rw - ext4 /dev/sda1 rw",
        "2 1 8:2 / /data rw - ext4 /dev/sdb1 rw",
        "3 1 0:1 / /proc rw - proc proc rw",
        "4 1 8:1 /docker/hosts /etc/hosts rw - ext4 /dev/sda1 rw",
        "5 1 0:2 / /media/My\\040Drive rw - fuseblk /dev/sdc1 rw",
        "6 1 0:3 / /mnt/team\\134share rw shared:1 - cifs //server/team rw",
        "7 1 0:4 / /remote rw - nfs4 server:/export rw",
        "8 1 8:2 / /data rw - ext4 /dev/sdb1 rw",
        "malformed",
      ].join("\n"),
    );
    expect(roots.map((root) => root.path)).toEqual([
      "/",
      "/data",
      "/media/My Drive",
      "/mnt/team\\share",
      "/remote",
    ]);
  });
});
