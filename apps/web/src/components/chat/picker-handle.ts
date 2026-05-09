// picker 与 InputBar 共享的 ref 接口: 键盘事件从 textarea 转发给 picker
// handleKey 返回 true 表示已消费该键 (InputBar 应 preventDefault 并不再继续处理)
import type { KeyboardEvent } from "react";

export interface PickerHandle {
  handleKey: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}
