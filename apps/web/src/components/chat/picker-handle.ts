// picker 与输入控件共享的 ref 接口；textarea 和普通 input 都可以把键盘事件转发进来。
// handleKey 返回 true 表示已消费该键，调用方应 preventDefault 并停止继续处理。
import type { KeyboardEvent } from "react";

export interface PickerHandle {
  handleKey: (e: KeyboardEvent<HTMLElement>) => boolean;
}
