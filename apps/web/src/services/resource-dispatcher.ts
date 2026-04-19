// 资源数据 dispatcher: 把 proxy 的 command_list_push / dir_list_response / file_tree_push
// 写进 command-store / file-store, 喂给 SlashCommandPicker 与 FilePathPicker
// file_tree_push 是 session 打开时的首轮文件树 (path = cwd), 与 dir_list_response 共享 store slot
import type { MessageEnvelope, RelayControlMessage } from "@cc-anywhere/shared";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { useCommandStore } from "@/stores/command-store";
import { useFileStore } from "@/stores/file-store";

type InboundMessage = MessageEnvelope | RelayControlMessage;

function handleCommandListPush(
  msg: Extract<RelayControlMessage, { type: "command_list_push" }>,
): void {
  useCommandStore.getState().setCommands(msg.commands);
}

function handleDirListResponse(
  msg: Extract<RelayControlMessage, { type: "dir_list_response" }>,
): void {
  useFileStore.getState().setDirEntries(msg.path, msg.entries);
}

function handleFileTreePush(
  msg: Extract<RelayControlMessage, { type: "file_tree_push" }>,
): void {
  const store = useFileStore.getState();
  store.setCwd(msg.path);
  store.setDirEntries(msg.path, msg.entries);
}

export function registerResourceDispatcher(): () => void {
  const relay = relayClientRef;
  if (!relay) {
    console.warn(
      "registerResourceDispatcher called before relayClient bound; skipping",
    );
    return () => {};
  }

  return relay.onMessage((msg: InboundMessage) => {
    switch (msg.type) {
      case "command_list_push":
        handleCommandListPush(msg);
        break;
      case "dir_list_response":
        handleDirListResponse(msg);
        break;
      case "file_tree_push":
        handleFileTreePush(msg);
        break;
      default:
        break;
    }
  });
}
