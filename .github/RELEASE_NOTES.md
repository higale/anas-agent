## Anas v3.3.2

- 新增可选插件框架：从本地已构建文件夹安装，支持启用、停用、卸载、侧边面板和独立窗口。纯界面插件无需后台，可选 Node 后台按需启动。
- 插件页面使用独立来源和专用宿主接口，支持普通数据持久化及脚本处理的表单提交；切换会话、收起面板或进入设置时保留页面状态。
- 插件与数据纳入应用备份和恢复；卸载保留数据。后台调用按顺序执行，停止时取消排队任务，保留在途结果，并报告清理失败；完善慢资源加载和 Windows 文件占用处理。
- 模型保存失败时显示本地化提示，并保留可查看的具体错误信息。
- 增加纯界面记事本与可选后台示例、插件开发文档和中英用户说明。RDP 等具体功能由独立插件提供，本次发布不包含 RDP 客户端。

- Add an optional plugin framework with installation from prebuilt local folders, enable/disable and uninstall controls, side panels, and separate windows. UI-only plugins need no backend; optional Node backends start on demand.
- Give plugin pages a separate origin and dedicated host APIs for ordinary persistent data and scripted form submission. Preserve page state when switching conversations, hiding panels, or opening settings.
- Include plugins and their data in application backup and restore, and retain data on uninstall. Serialize backend calls, cancel queued work on stop, preserve in-flight results, and report cleanup failures. Handle slow resource loading and temporary Windows file locks.
- Show localized model-save failure messages while retaining inspectable diagnostic details.
- Add a UI-only notepad example, an optional-backend example, plugin developer documentation, and bilingual user guidance. Specialized features such as RDP belong in separate plugins; this release does not include an RDP client.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/README.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/README.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
