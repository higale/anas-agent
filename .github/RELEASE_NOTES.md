## Anas v5.1.1

- 项目支持自定义图片图标。项目和供应商使用相同的图片导入规则，位图最大为 128 × 128 像素。项目设置会在图片处理完成后允许保存。
- 模型选择提示中，最大输出单独显示一行，压缩阈值同时显示配置比例及对应的实际数值。
- 编码模式按模型配置的阈值触发压缩，已加载的项目规则计入实际输入用量。修复手动压缩因继承上一轮规则状态而失败的问题，并按所选模型协议检查摘要能否放入上下文。

- Projects now support custom image icons. Project and provider icons share the same import rules, with a maximum bitmap size of 128 × 128 pixels. Project settings wait for image processing to finish before enabling Save.
- The model picker tooltip shows maximum output on its own line and displays both the configured compression percentage and the corresponding input limit.
- Coding mode now uses the model’s configured compression threshold and counts loaded project rules as input. Manual compression handles rule state across turns and checks that the summary fits using the selected model’s protocol.

## 较早版本升级 / Upgrading from earlier versions

- 从 5.0.2～5.0.9 升级时，原有偏好记忆保留在旧库，可将要沿用的偏好手动添加到全局或项目记忆。
- 从 5.0.1 或更早版本跨越 5.0.2 升级，需要重置全部项目与会话。5.0 不支持导入旧版对话、记忆、运行记录或整包备份；兼容配置与扩展资源的手动复制方式见 [5.0 升级说明](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_5.zh-CN.md)。
- 从 4.0 之前的版本跨入 4.x 时，历史数据目录有变化，见 [4.x 升级说明](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.zh-CN.md)；其中的数据库恢复方法不适用于 5.0。

- When upgrading from 5.0.2–5.0.9, existing preference memories remain in the old database. Add the preferences you want to keep to global or project memory.
- Upgrading from 5.0.1 or earlier across the 5.0.2 boundary requires resetting all projects and conversations. Version 5.0 cannot import older conversations, memories, run history or full backups. See the [5.0 upgrade guide](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_5.en.md) for manually copying compatible settings and extensions.
- Moving from a version before 4.0 into 4.x also involves historical data folder changes. See the [4.x upgrade guide](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.en.md); its database recovery instructions do not apply to 5.0.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.zh-CN.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
