import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { expect, it } from "vitest";
import { PtyRuntime } from "#src/common/pty-runtime.js";

it.skipIf(process.platform !== "darwin")(
  "lists, completes and edits Chinese paths in a real Shell started without a locale",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "dev-anywhere-shell-locale-"));
    const filename = "微信图片_2026-06-19.jpg";
    writeFileSync(join(root, filename), "fixture");
    mkdirSync(join(root, "中文目录"));
    // An ordinary interactive shell, as launched by the service: no login profile and
    // no user startup files that could silently supply LANG and hide the regression.
    writeFileSync(join(root, ".zshrc"), "PROMPT='DA_READY> '\nRPROMPT=''\n");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== "LANG" && !key.startsWith("LC_")),
    );
    let output = "";
    const runtime = new PtyRuntime(
      {
        sessionId: "native-macos-shell-locale",
        kind: "terminal",
        shell: "/bin/zsh",
        cwd: root,
        cols: 120,
        rows: 32,
        env: {
          ...env,
          HOME: root,
          ZDOTDIR: root,
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          SHELL: "/bin/zsh",
        },
      },
      {
        output: (data) => {
          output += data;
        },
        resize() {},
        title() {},
        cwd() {},
        semantic() {},
        exit() {},
      },
    );
    const visible = () => stripVTControlCharacters(output);
    try {
      runtime.start();
      await expect.poll(visible, { timeout: 5_000 }).toContain("DA_READY> ");

      runtime.write("printf '\\nDA_LIST_START\\n'; /bin/ls -1; printf 'DA_LIST_END\\n'\r");
      await expect.poll(visible, { timeout: 5_000 }).toContain("\r\nDA_LIST_END\r\n");
      const listing = visible().split("\r\nDA_LIST_START\r\n")[1]?.split("\r\nDA_LIST_END")[0];
      expect(listing).toContain(filename);
      expect(listing).toContain("中文目录");
      expect(listing).not.toContain("?");

      output = "";
      runtime.write("printf 'DA_FILE=<%s>\\n' ./微\t");
      await expect.poll(visible, { timeout: 5_000 }).toContain(filename);
      expect(visible()).not.toContain("$'");
      runtime.write("\r");
      await expect.poll(visible, { timeout: 5_000 }).toContain(`DA_FILE=<./${filename}>`);

      output = "";
      runtime.write("printf 'DA_DIR=<%s>\\n' ./中\t");
      await expect.poll(visible, { timeout: 5_000 }).toContain("中文目录/");
      runtime.write("\r");
      // zsh removes the completion's trailing slash when accepting this argument.
      await expect.poll(visible, { timeout: 5_000 }).toContain("DA_DIR=<./中文目录>");

      // Backspace must erase one complete Chinese character, not one UTF-8 byte.
      runtime.write("printf 'DA_EDIT=<%s>\\n' '中文\x7f字'\r");
      await expect.poll(visible, { timeout: 5_000 }).toContain("DA_EDIT=<中字>");
    } catch (error) {
      console.error("macOS Shell locale output:", JSON.stringify(output.slice(-4_096)));
      throw error;
    } finally {
      await runtime.terminate();
      rmSync(root, { recursive: true, force: true });
    }
  },
  25_000,
);
