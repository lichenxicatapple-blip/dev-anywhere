// 数据旁路接口，Phase 2 为空操作，Phase 3-4 将注入 relay 转发逻辑
export type DataTap = (data: string) => void;

export function createNoopTap(): DataTap {
  return (_data: string) => {};
}
