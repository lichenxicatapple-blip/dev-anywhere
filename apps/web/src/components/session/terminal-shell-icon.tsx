import { Terminal } from "lucide-react";
import type { TerminalShell } from "@dev-anywhere/shared";
import cmdIcon from "@/assets/shells/cmd.png";
import powershellIcon from "@/assets/shells/powershell.png";
import windowsPowershellIcon from "@/assets/shells/windows-powershell.png";

export function TerminalShellIcon({ shell, label }: { shell?: TerminalShell; label: string }) {
  const src =
    shell === "cmd"
      ? cmdIcon
      : shell === "powershell"
        ? label === "Windows PowerShell"
          ? windowsPowershellIcon
          : powershellIcon
        : null;

  if (!src) {
    return <Terminal className="size-5 text-muted-foreground" aria-hidden="true" />;
  }

  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      className="size-5 shrink-0 object-contain"
      width={20}
      height={20}
      draggable={false}
    />
  );
}
