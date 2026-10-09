## Anas v3.3.8

- 统一侧栏与独立窗口的页面交接，恢复未保存内容和阅读位置，保留插件后台连接；交接失败时返回原页面。
- 支持侧栏标签拖动排序、拖出为独立窗口，优化宽度调整、标签菜单和提示样式。
- 插件增加默认／页面图标、后台调用页面信息、指定实例移动及列表操作图标。
- 覆盖安装前显示新旧版本并确认，默认保留数据，可选择清除；失败时回滚并保全恢复文件。
- 插件接口升级为 API 2，API 1 插件需更新后使用；内置示例已适配，RDP 插件请配套升级至 0.1.7。

- Unify page handoff between the sidebar and separate windows, restoring drafts and reading positions while retaining plugin backend connections; return to the original page if a handoff fails.
- Reorder sidebar tabs by dragging, drag tabs into separate windows, and improve panel resizing, tab menus, and tooltips.
- Add default and per-page plugin icons, backend caller context, movement of a specified instance, and a list toolbar icon.
- Confirm plugin replacement with installed and incoming versions. Keep data by default, allow explicit removal, and roll back failures while preserving recovery files.
- Upgrade the plugin interface to API 2. API 1 plugins require updates; bundled examples are updated, and RDP users should upgrade to plugin 0.1.7.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/README.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/README.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
