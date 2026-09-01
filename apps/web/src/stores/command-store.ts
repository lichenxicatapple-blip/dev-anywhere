// 命令列表缓存：slash command 列表和更新时间
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { CommandEntry } from "@dev-anywhere/shared";

interface CommandStoreState {
  commands: CommandEntry[];
  lastUpdated: number;
  activeSessionId: string | null;
  commandsBySessionId: Record<string, CommandEntry[]>;
  legacyCommands: CommandEntry[];

  setActiveSession: (sessionId: string | null) => void;
  setCommands: (commands: CommandEntry[]) => void;
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
      legacyCommands: [],

      setActiveSession: (sessionId) =>
        set((state) => {
          let commands = state.legacyCommands;
          if (
            sessionId !== null &&
            Object.prototype.hasOwnProperty.call(state.commandsBySessionId, sessionId)
          ) {
            commands = state.commandsBySessionId[sessionId];
          }
          return {
            activeSessionId: sessionId,
            commands,
            lastUpdated: Date.now(),
          };
        }),

      // Compatibility path for proxies that still publish one unscoped command snapshot.
      setCommands: (commands) =>
        set({ commands, legacyCommands: commands, lastUpdated: Date.now() }),

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
          legacyCommands: [],
        }),
    }),
    { name: "command-store" },
  ),
);
