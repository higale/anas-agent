## Anas v5.0.7

- 模型设置中的压缩阈值同时显示百分比和对应的 token 数，并补充计算说明，方便判断何时开始压缩上下文。
- 压缩阈值支持按 1% 调整，更方便选择合适的比例。
- 修复备份后用量仪表等插件后台不再自动恢复的问题；备份完成或失败后恢复此前正常运行的后台，保留手动停止和故障状态，恢复失败会提示并记录具体原因。

**备份仍会暂时停止插件后台；重新启动不能恢复被中断的任务或连接。**

**从 5.0.2～5.0.6 升级无需重置项目或会话。**

- Model settings now show both the compression threshold percentage and its token count, with an explanation of the calculation to make compression timing clearer.
- Adjust the compression threshold in 1% increments for finer control.
- Fix plugin backends, including Usage Meter, remaining stopped after a backup. Previously running, healthy backends restart after either a successful or failed backup. Manually stopped and failed backends stay stopped; restart failures are reported and logged with details.

**Backups still temporarily stop plugin backends. Restarting cannot restore interrupted tasks or connections.**

**Upgrading from 5.0.2–5.0.6 does not require resetting projects or conversations.**

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
