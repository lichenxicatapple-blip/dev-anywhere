# DEV Anywhere 文档索引

当前文档按用途分层。根目录只保留少量项目入口；过程性计划不再作为开发依据。

## 当前入口

| 文档                  | 用途                                    |
| --------------------- | --------------------------------------- |
| `CLAUDE.md`           | 当前开发约定、架构摘要、部署提示。      |
| `PUBLISHING.md`       | 发布版本、镜像、npm 与 VPS 部署流程。   |
| `docs/SCRIPTS.md`     | 本地开发、生产部署、治理脚本入口说明。  |
| `docs/LOCAL-SMOKE.md` | 本机真实 relay/proxy/web/PTY 手测清单。 |

## 当前治理规则

| 文档                                           | 用途                                   |
| ---------------------------------------------- | -------------------------------------- |
| `docs/governance/ARCHITECTURE-GOVERNANCE.md`   | 模块边界、owner、重写准入规则。        |
| `docs/governance/PROTOCOL-STATE-GOVERNANCE.md` | 协议、状态机、permission/status 规则。 |

## 研究材料

| 文档                                   | 用途                          |
| -------------------------------------- | ----------------------------- |
| `docs/research/TECH-DIFF-LINKSHELL.md` | 和 LinkShell 的技术差异审计。 |

研究材料可以参考，但不能覆盖当前代码事实。实现前以源码、测试和 governance 文档为准。

## 历史归档

| 文档                               | 用途                                   |
| ---------------------------------- | -------------------------------------- |
| `docs/archive/PROJECT-RESCUE.md`   | 救援期历史计划，未完成事项仍可参考。   |
| `docs/archive/NAMING-MIGRATION.md` | 命名迁移记录，未完成命名清理仍可参考。 |

归档文档不能覆盖当前代码事实；执行前必须回到源码、测试和 governance 文档确认。

## Notes

`.planning/notes/` 暂时保留。只有在确认某条 note 已完成，且信息已经被当前代码、测试或正式文档吸收后，才删除对应 note。

`.planning/todos/pending/` 暂时保留，按未完成事项处理。`.planning` 里的旧阶段计划、quick 计划、codebase/research 生成文档不再作为开发入口。
