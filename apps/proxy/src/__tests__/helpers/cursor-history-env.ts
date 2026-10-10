// Cursor 历史目录由三个环境变量共同决定（见 serve/history/paths.ts）：
// CURSOR_ACP_SESSIONS_DIR > CURSOR_CONFIG_DIR > $XDG_CONFIG_HOME/cursor > ~/.cursor。
// 测试把样本写在临时 HOME 的默认目录时，必须同时清掉这三个变量，否则开发机或 CI
// 上已有的值会让读取代码去别的目录查找。
const CURSOR_HISTORY_ENV_KEYS = [
  "CURSOR_ACP_SESSIONS_DIR",
  "CURSOR_CONFIG_DIR",
  "XDG_CONFIG_HOME",
] as const;

/** 保存并清除所有影响 Cursor 历史目录的环境变量，返回用于恢复原值的函数。 */
export function isolateCursorHistoryEnv(): () => void {
  const saved = CURSOR_HISTORY_ENV_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of CURSOR_HISTORY_ENV_KEYS) delete process.env[key];
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
