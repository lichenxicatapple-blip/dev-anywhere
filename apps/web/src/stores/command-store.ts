// 命令列表缓存：slash command 列表和更新时间
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { CommandEntry } from "@cc-anywhere/shared";

interface CommandStoreState {
  commands: CommandEntry[];
  lastUpdated: number;

  setCommands: (commands: CommandEntry[]) => void;
}

export const useCommandStore = create<CommandStoreState>()(
  devtools(
    (set) => ({
      commands: [],
      lastUpdated: 0,

      setCommands: (commands) => set({ commands, lastUpdated: Date.now() }),
    }),
    { name: "command-store" },
  ),
);
