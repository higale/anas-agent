## Anas v5.0.4

- 对话记录较多时，启动后侧栏和当前对话更快显示，打开长对话更流畅。
- 模型报错后可直接点击“重试”，从失败处继续，无需重发消息，也不会重复执行已完成的工具。重试较早的错误时，会先确认是否移除后续对话内容；工具已经产生的操作不会撤销。
- 工具返回内容导致模型请求失败时，可选择“重试（不返回工具结果）”。该轮返回内容会替换为不返回结果的说明，重启后仍然保留这一选择；工具已经产生的操作不会撤销。
- 修复从历史错误处重试后，待办计划丢失的问题。
- 修正对话压缩后的上下文用量显示，避免漏算召回记忆占用的空间。

**从 5.0.2 或 5.0.3 升级无需重置项目或会话。**

- The sidebar and current conversation appear sooner at startup when you have a large chat history, and long conversations open more smoothly.
- After a model error, click **Retry** to continue from the failed request without resending your message or repeating completed tool actions. Retrying an earlier error asks you to confirm removing later conversation content; actions already performed by tools are not undone.
- If tool output causes a model request to fail, choose **Retry without tool results**. That round’s output is replaced with a note that the results were withheld, and this choice persists after restarting. Actions already performed by tools are not undone.
- Fix to-do plans being lost when retrying an earlier error.
- Fix context usage after conversation compaction undercounting the space used by recalled memories.

**Upgrading from 5.0.2 or 5.0.3 does not require resetting projects or conversations.**

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
