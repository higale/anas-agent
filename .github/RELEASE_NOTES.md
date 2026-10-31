## Anas v5.0.5

- 模型响应中断、工具调用不完整或格式有误时，会自动尝试恢复，已完成的工具不会重复执行。
- 回答达到长度上限时，保留已有文字并尝试继续回答；不完整的工具调用会重新生成，避免执行半截操作。
- 自动恢复与网络重试共用最多两次重试，界面显示恢复原因和次数；等待时可停止，重试耗尽后仍可手动重试。
- 修复对话压缩失败时重复重试过多的问题，异常退出后重新打开也会保留已用次数。
- 附件无法读取或提取文字时，会明确告知模型内容缺失，便于继续处理或说明需要补充的信息。
- 普通运行日志记录自动恢复和手动重试的过程与错误详情，方便排查问题。

**从 5.0.2～5.0.4 升级无需重置项目或会话。**

- Automatically attempt recovery when a model response is interrupted or contains incomplete or malformed tool calls, without repeating completed tool actions.
- Keep existing text and attempt to continue when an answer reaches its length limit. Regenerate incomplete tool calls instead of executing partial actions.
- Automatic recovery and network retries share a limit of two retries. The interface shows the reason and count; you can stop while waiting or retry manually after automatic attempts are exhausted.
- Fix excessive retries when conversation compaction fails. Used attempts remain counted after an unexpected shutdown and restart.
- Tell the model when an attachment cannot be read or its text cannot be extracted, so it can continue with available information or explain what is missing.
- Record automatic recovery and manual retries, including error details, in ordinary application logs to help troubleshoot problems.

**Upgrading from 5.0.2–5.0.4 does not require resetting projects or conversations.**

## 较早版本升级 / Upgrading from earlier versions

- 从 5.0.1 或更早版本跨越 5.0.2 升级，需要重置全部项目与会话。5.0 不支持导入旧版对话、记忆、运行记录或整包备份；兼容配置与扩展资源的手动复制方式见 [5.0 升级说明](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_5.zh-CN.md)。
- 从 4.0 之前的版本跨入 4.x 时，历史数据目录有变化，见 [4.x 升级说明](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.zh-CN.md)；其中的数据库恢复方法不适用于 5.0。

- Upgrading from 5.0.1 or earlier across the 5.0.2 boundary requires resetting all projects and conversations. Version 5.0 cannot import older conversations, memories, run history or full backups. See the [5.0 upgrade guide](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_5.en.md) for manually copying compatible settings and extensions.
- Moving from a version before 4.0 into 4.x also involves historical data folder changes. See the [4.x upgrade guide](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.en.md); its database recovery instructions do not apply to 5.0.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.zh-CN.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
