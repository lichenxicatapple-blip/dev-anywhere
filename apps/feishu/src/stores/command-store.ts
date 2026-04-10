// 命令列表缓存：slash command 列表和更新时间
import { createContext, useContext } from "react";
import type { CommandEntry } from "@cc-anywhere/shared";

export type { CommandEntry };

export interface CommandStoreState {
  commands: CommandEntry[];
  lastUpdated: number;
}

export type CommandAction =
  | { type: "SET_COMMANDS"; commands: CommandEntry[] };

export const initialCommandState: CommandStoreState = {
  commands: [],
  lastUpdated: 0,
};

export function commandReducer(
  state: CommandStoreState,
  action: CommandAction,
): CommandStoreState {
  switch (action.type) {
    case "SET_COMMANDS":
      return { commands: action.commands, lastUpdated: Date.now() };
    default:
      return state;
  }
}

const CommandStateContext = createContext<CommandStoreState>(initialCommandState);
const CommandDispatchContext = createContext<React.Dispatch<CommandAction>>(() => {
  throw new Error("CommandDispatchContext used outside CommandProvider");
});

export const CommandProvider = CommandStateContext.Provider;
export const CommandDispatchProvider = CommandDispatchContext.Provider;

export function useCommandState(): CommandStoreState {
  return useContext(CommandStateContext);
}

export function useCommandDispatch(): React.Dispatch<CommandAction> {
  return useContext(CommandDispatchContext);
}
