## Anas v3.3.12

- 插件支持按内容适配独立窗口，工具栏使用包内图标，操作过多时自动收进菜单。
- 向插件后台提供面板活动状态订阅，支持按当前操作页面调度资源。
- 修复插件覆盖安装期间错误提示被刷新覆盖的问题。

- Let plugins fit separate windows to content, use packaged toolbar icons, and move overflow actions into a menu.
- Expose panel activity subscriptions so plugin backends can schedule resources for the active page.
- Keep plugin replacement errors visible instead of overwriting them during refresh.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/README.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/README.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
