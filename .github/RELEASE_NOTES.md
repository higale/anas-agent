## Anas v3.3.18

- 内置插件与插件示例统一使用 `plugins_system/`、`plugins_examples/` 目录，启动和恢复备份时同步到应用数据目录；内置插件从同步后的目录加载。
- 安装插件时默认打开示例目录，随包提供记事本、文本工具、写作助手和可选后台示例，并补充中英文使用说明；示例需手动安装后使用。
- 刷新内置插件与示例时保留用户已安装的插件、独立数据和启停设置；受支持备份缺少这些目录时自动补齐。

- Standardize built-in plugins and examples under `plugins_system/` and `plugins_examples/`, refreshing them in application data at startup and after backup restore. Built-in plugins load from the refreshed directory.
- Open the examples directory by default when installing plugins. Bundle notepad, text tools, writing helper and optional backend examples with Chinese and English instructions; examples require manual installation.
- Preserve installed plugins, independent data and enabled states when refreshing bundled resources. Recreate missing resource directories when restoring supported backups.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/README.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/README.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
