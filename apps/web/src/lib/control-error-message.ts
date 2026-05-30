import { ControlErrorCode } from "@dev-anywhere/shared";
import type { ControlErrorCode as ControlErrorCodeType } from "@dev-anywhere/shared";

// proxy 端 fs 错误已经按 errorCode 分类好, 但 result.error 是 node 抛的原始字符串
// (如 "ENOENT: no such file or directory, lstat '/abs/path'"), 直接 toast 给用户看体验差。
// 这里按 errorCode 翻译, UNKNOWN / 没分类的才退回 raw error / fallback。
const ERROR_CODE_MESSAGES: Partial<Record<ControlErrorCodeType, string>> = {
  [ControlErrorCode.PATH_NOT_FOUND]: "文件不存在",
  [ControlErrorCode.PATH_NOT_DIRECTORY]: "路径不是目录",
  [ControlErrorCode.PATH_ACCESS_DENIED]: "无权访问该路径",
  [ControlErrorCode.INVALID_PATH]: "路径无效",
  [ControlErrorCode.SESSION_NOT_FOUND]: "会话已结束",
  [ControlErrorCode.PROXY_OFFLINE]: "开发机已离线",
  [ControlErrorCode.PROVIDER_UNSUPPORTED]: "不支持的 Provider",
  [ControlErrorCode.WORKER_START_FAILED]: "Worker 启动失败",
  [ControlErrorCode.PROCESS_START_FAILED]: "进程启动失败",
};

interface DescribeControlErrorOptions {
  errorCode?: ControlErrorCodeType;
  rawError?: string;
  fallback: string;
}

export function describeControlError(opts: DescribeControlErrorOptions): string {
  const friendly = opts.errorCode ? ERROR_CODE_MESSAGES[opts.errorCode] : undefined;
  if (friendly) return friendly;
  if (opts.rawError && opts.rawError.trim().length > 0) return opts.rawError;
  return opts.fallback;
}
