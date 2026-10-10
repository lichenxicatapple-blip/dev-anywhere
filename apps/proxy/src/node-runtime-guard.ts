// 副作用模块：必须是入口文件的第一个 import。
// 旧版本的自动更新器只会安装新包并执行 `dev-anywhere --version`；在这里以非零状态退出，
// 才能让旧更新器判定校验失败并恢复旧包。
import { unsupportedNodeMessage } from "./common/node-version.js";

const unsupported = unsupportedNodeMessage(process.versions.node);
if (unsupported) {
  process.stderr.write(`${unsupported}\n`);
  process.exit(1);
}
