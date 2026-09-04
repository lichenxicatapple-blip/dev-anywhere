// 命令列表缓存：slash command 列表和更新时间
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { CommandEntry } from "@dev-anywhere/shared";

interface CommandStoreState {
  commands: CommandEntry[];
  lastUpdated: number;
  activeSessionId: string | null;
  commandsBySessionId: Record<string, CommandEntry[]>;

  setActiveSession: (sessionId: string | null) => void;
  setSessionCommands: (sessionId: string, commands: CommandEntry[]) => void;
  clear: () => void;
}

export const useCommandStore = create<CommandStoreState>()(
  devtools(
    (set) => ({
      commands: [],
      lastUpdated: 0,
      activeSessionId: null,
      commandsBySessionId: {},

      setActiveSession: (sessionId) =>
        set((state) => ({
          activeSessionId: sessionId,
          commands: sessionId === null ? [] : (state.commandsBySessionId[sessionId] ?? []),
          lastUpdated: Date.now(),
        })),

      setSessionCommands: (sessionId, commands) =>
        set((state) => ({
          commandsBySessionId: {
            ...state.commandsBySessionId,
            [sessionId]: commands,
          },
          ...(state.activeSessionId === sessionId ? { commands, lastUpdated: Date.now() } : {}),
        })),
      clear: () =>
        set({
          commands: [],
          lastUpdated: 0,
          activeSessionId: null,
          commandsBySessionId: {},
        }),
    }),
    { name: "command-store" },
  ),
);
