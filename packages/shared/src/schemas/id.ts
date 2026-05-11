import { z } from "zod";

// 所有跨进程传递的标识符 (proxyId / clientId / sessionId / requestId / toolId) 的统一上限。
// 设计原因:
// - nanoid (proxy/session/client 服务端默认生成) = 21 字符
// - claude tool_use id (toolu_<base64ish>) ≈ 30-40 字符
// - codex tool id 类似量级
// 256 给协议演进留余量, 同时挡住 wire 上来的恶意超长 ID:
// - Map<id, _> key 占用 (memory DoS)
// - 日志行膨胀 (operator/磁盘压力)
// - 拼到 disk path (虽然当前没有此路径, defense in depth)
const MAX_ID_LENGTH = 256;

export const IdSchema = z.string().min(1).max(MAX_ID_LENGTH);
