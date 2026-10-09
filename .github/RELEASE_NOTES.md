## Anas v3.3.7

- 插件首页在侧栏和独立窗口间保持唯一，重复打开保留当前位置、连接和未保存内容。
- 修复 Windows 关闭主窗口后插件窗口和后台残留；保留 macOS 隐藏主窗口的行为。
- 插件数据目录统一为 `plugins_data/`；原有 `plugin_data/` 不自动迁移。

- Reuse one plugin home across the sidebar and windows, preserving its placement, connections, and unsaved content.
- Clean up plugin windows and backends when the Windows main window closes; retain the macOS hide-on-close behavior.
- Use `plugins_data/` for plugin data; existing `plugin_data/` directories are not migrated automatically.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/README.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/README.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
