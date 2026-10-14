## Anas v3.3.13

- 完善插件页面关闭、重开及并发调用生命周期；独立窗口完成准备后再显示，减少首次展示跳动。
- 独立面板支持可拖动的全屏工具栏、分组菜单及原色图标；修复跨屏位置恢复和窗口尺寸取整，区分用户缩放与程序适配。
- 上下文超限时，将过长工具结果的完整内容保留为本地文件，并在预览中提供路径；原始聊天记录保留，结果文件随备份保存，目前不随对话删除。
- 为插件提供临时目录，并更新插件接口和用户文档。RDP 0.1.9 请配套使用本版或更新的宿主。

- Improve plugin page closure, reopening and concurrent calls. Separate windows become visible after preparation to reduce initial layout jumps.
- Add draggable fullscreen toolbars, grouped menus and full-color icons. Fix cross-display placement and window-size rounding, and distinguish user resizing from programmatic fitting.
- When context exceeds its limit, preserve complete oversized tool results in local files and link them from previews. Original history is retained; result files are backed up and currently remain after conversation deletion.
- Expose a temporary directory to plugins and update API and user documentation. RDP 0.1.9 requires this host version or later.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/README.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/README.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
