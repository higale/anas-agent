## Anas v3.3.9

- 插件可声明模型工具、技能、静态提示词和通用设置；新增无页面工具及纯声明插件示例，工具支持文本、JSON 和图片结果。
- 简化能力设置：移除全局默认能力页，项目与子 Agent 使用“全部／定制／关闭”，插件贡献集中按插件选择；完善停用条目编辑和技能可用性冲突提示。
- 插件业务状态与对话生命周期解耦，取消或超时不再终止共享后台；改进停止收尾和执行中插件包的覆盖／卸载保护。
- 后台支持查询、打开和移动插件页面；独立窗口标题栏支持锁图标及选中状态。
- 设置页增加插件提示词、技能和工具预览，工具目录显示实际模型名称；预览和配置不启动后台，减少保存及后台操作时的页面闪烁。
- 插件安装窗口跟随应用语言，ZIP 与 JSON 分开筛选并默认 ZIP；首页启动菜单只显示有页面的插件，停用时仍可设置首页位置。
- 修复历史活动刷新覆盖已完成时间的问题，同步中英文手册与插件开发文档。

- Plugins can declare model tools, skills, static instructions, and shared settings. New examples cover tools without a page and static contributions; tools support text, JSON, and image results.
- Simplify capability settings: remove global default capabilities, use All / Custom / Off in projects and subagents, and group contributions by plugin. Improve editing of disabled sources and warnings for unavailable skill selections.
- Decouple plugin business state from conversation lifecycles. Cancellation and timeouts no longer terminate shared backends; improve shutdown cleanup and protect plugin packages used by active tools from replacement or removal.
- Let backends query, open, and move plugin pages; add lock icons and pressed states to separate-window toolbar actions.
- Preview plugin instructions, skills, and tools in settings and show actual model-facing tool names in the catalog. Previews and configuration do not start backends; reduce flicker during saves and backend operations.
- Localize the plugin file picker, split ZIP and JSON filters with ZIP selected by default, and list only plugins with pages in the launch menu. Home page location remains editable while a plugin is disabled.
- Fix activity refreshes overwriting completion times, and update bilingual guides and plugin development documentation.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/README.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/README.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
