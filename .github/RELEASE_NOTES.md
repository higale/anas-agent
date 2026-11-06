## Anas v5.2.0

- **升级注意：会话数据库改为 v3。旧对话不迁移、不自动删除，含会话 v1／v2 的备份不能恢复；升级前请备份并自行清空旧对话。配置、项目定义、扩展资源及独立记忆库保持原格式。** 详见[升级说明](https://github.com/higale/anas-agent/blob/v5.2.0/data/help/UPGRADE_TO_5.zh-CN.md)。
- 重构长轮次显示：按组读取活动、按需读取正文，统一虚拟列表，修复加载提示闪烁、滚动跳动和工具展开状态丢失。
- 最外层动态显示运行用时；过程组显示当前思考或工具步骤，后续回复出现或运行结束时自动收起，保留之后的手动选择。
- 聊天显示设置统一内容宽度、运行过程展开／收起、轮次信息显示／隐藏；隐藏轮次时移除空过程组和重复运行指示。
- 修复子 Agent 窗口同步与读取取消、历史编辑失败时的记忆游标回滚，以及显示目录修复误报；停止重复保存注入的偏好记忆正文。

- **Upgrade notice: conversation databases now use v3. Old conversations are neither migrated nor automatically deleted, and backups containing v1/v2 conversations cannot be restored. Back up your data and clear old conversations before upgrading. Settings, project definitions, extensions, and the separate memory database retain their formats.** See the [upgrade guide](https://github.com/higale/anas-agent/blob/v5.2.0/data/help/UPGRADE_TO_5.en.md).
- Redesigned long-run displays with activity groups, on-demand detail reads, and one virtualized timeline. Fixed flickering loading indicators, scroll jumps, and lost tool expansion choices.
- The outer fold shows live elapsed time. Process groups show the current reasoning or tool step, collapse when a following reply appears or the run ends, and preserve subsequent manual choices.
- Chat display settings now bring together content width, running-process expansion, and round visibility. Hiding rounds removes empty groups and duplicate running indicators.
- Fixed subagent window synchronization and read cancellation, memory cursor rollback after failed history edits, and false display-directory repair reports. Injected preference memory is no longer saved repeatedly in conversation storage.
