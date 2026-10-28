## Anas v5.0.0

- 执行、消息、工具、审批、压缩、子 Agent 和恢复改用自有原生运行时，移除 LangChain、LangGraph、Deep Agents 及其适配依赖，保留现有聊天、设置和插件界面。
- 会话与执行状态使用全新的 v1 数据库；移除旧执行库 v0 → v1 转换，旧对话、记忆和运行记录不迁移，旧版整包备份不能恢复。
- 工具活动、审批和追加指令统一使用应用调用 ID，修复供应商重复 ID 导致记录覆盖及流式工具卡片重复；现有 v1 展示索引可从持久记录重建。
- 修复面板加载失败的错误保留和重试，以及连续打开同一面板时取消首次创建的问题。
- 当前格式的文件修改历史按原平台路径语义校验，跨平台不自动映射或执行原机器的文件操作。
- 修复 macOS 恢复事务对同一目录不同路径写法的识别，以及 Shell 路径中非法中间组件的校验。
- 默认数据目录统一为 `~/.anas`，开发和打包一致；保留 `--data-dir`，旧目录不会自动导入。

- Replace execution, messages, tools, approvals, compression, subagents and recovery with the native runtime. Remove LangChain, LangGraph, Deep Agents and their adapters while preserving the existing chat, settings and plugin interfaces.
- Use a fresh v1 database for conversation and execution state. Remove v0-to-v1 conversion; previous conversations, memory and execution records are not migrated, and legacy full backups cannot be restored.
- Use application call IDs for tool activity, approvals and queued directions. Prevent reused provider IDs from overwriting activity or duplicating streamed tool cards, and rebuild existing v1 display indexes from durable records.
- Preserve panel loading errors for retry and prevent repeated opens from cancelling the initial panel creation.
- Validate current-format file-edit history using its original platform’s path semantics, without automatically mapping or executing file operations from another platform.
- Recognize equivalent directory paths when recovering transactions on macOS, and reject invalid intermediate components in Shell operand paths.
- Use `~/.anas` as the default data directory in development and packaged builds. Keep `--data-dir`; old directories are not imported automatically.

**5.0 升级提醒：** 旧数据库和旧版整包备份不兼容；配置与扩展资源的手动复制方法见 [5.0 升级数据说明](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_5.zh-CN.md)。

**历史升级提醒：** 4.0 曾调整数据布局，跨入 4.x 的影响见 [4.x 升级数据说明](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.zh-CN.md)，该说明只适用于 4.x。

**5.0 upgrade notice:** Legacy databases and full backups are incompatible. See the [5.0 upgrade data guide](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_5.en.md) for copying compatible settings and extensions manually.

**Historical upgrade notice:** Version 4.0 changed the data layout. See the [4.x upgrade data guide](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.en.md) for its impact; that guide applies only to 4.x.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.zh-CN.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
