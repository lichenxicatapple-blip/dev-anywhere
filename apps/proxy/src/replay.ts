// replay.ts -- 全链路终端帧回放验证工具
// TODO: Migrate to EventStore + binary frame in Plan 09-02/03
// 当前版本的 replay 依赖已删除的 TerminalTracker + FramePusher + TerminalFrameRenderer，
// 需要迁移到新的 EventStore + binary IPC 链路后才能恢复功能

export interface ReplayOptions {
  speed?: number;
  remote?: boolean;
}

export async function runReplay(_fixturePath: string, _options: ReplayOptions = {}): Promise<void> {
  throw new Error("replay not yet migrated to v2 pipeline -- see Plan 09-02/03");
}
