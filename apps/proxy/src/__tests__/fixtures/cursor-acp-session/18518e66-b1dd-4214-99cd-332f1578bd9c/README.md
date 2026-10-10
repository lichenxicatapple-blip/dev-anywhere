# Cursor ACP 真实会话样本

由 Cursor CLI `2026.09.26-dd393fe` 的 `agent acp`（ask 模式）生成：一个无关会话，两轮对话
（解释 TCP 三次握手；读取临时目录里的 `hello.txt`，触发一次 `Read` 工具调用）。

脱敏处理：

- system 提示词和包含本机环境、技能列表的 user_info blob 被替换为占位文本；
- `meta` 里的 `blobEncryptionKey` 被清零；
- `meta.json` 的 `cwd` 改成 `/workspace/cursor-sample`（历史目录会过滤临时目录下的会话，原值是 `/tmp/...`；tool 结果里仍保留原始的 `/tmp` 路径）；
- 其余 blob（根节点、assistant、tool、protobuf 结构节点）保持 Cursor 写出的原样。

用于 `cursor-acp-real-store.test.ts`，验证读取逻辑能处理官方 CLI 实际写出的 `store.db`。
