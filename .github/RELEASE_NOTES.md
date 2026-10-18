## Anas v4.0.2

**升级提醒：从 4.0 之前的版本升级到 4.x，旧对话和长期记忆不再可用；项目、输入历史、插件数据和头像可手动恢复。升级前请备份，详见 [4.x 升级数据说明](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.zh-CN.md)。** 此提醒针对跨入 4.x 的升级，并非每次 4.x 升级都会丢失数据。

**本次插件兼容性变更：** 用户插件安装目录取消旧的 `package/` 层级。已有用户插件会显示加载错误，需要重新覆盖安装同 ID 插件；保持“删除插件数据”不勾选即可保留业务数据、配置及首页位置。旧安装状态不自动迁移，新状态文件缺失时默认启用、不显示标题栏图标。内置插件不受此布局调整影响。

- 文件改动与插件入口合并到工作区菜单，按当前项目和插件分组；插件标题右侧提供设置齿轮。可在插件设置中开启独立的标题栏启动图标，默认关闭。
- 简化记事本页面：删除顶部标题，侧栏保存按钮右对齐，独立窗口使用标题栏保存入口；统一明暗主题下的按钮外观和交互状态。
- 用户插件直接安装到 `plugins/<id>/`，安装设置统一存入 `db/plugins/<id>/anas-installation.json`。覆盖安装保留启用状态和标题栏图标设置，卸载后重装恢复默认；完善代码、安装设置和业务数据的事务回滚与中断恢复。
- 四个插件示例以独立 ZIP 随包提供，可直接选择安装；仓库保留源码。启动及恢复备份时整体刷新示例，保留已安装副本。
- 新增中英文 4.x 升级数据说明，可从用户手册离线查看，集中说明受影响数据、备份、手动恢复路径和旧文件清理。

**Upgrade notice: when upgrading from a pre-4.0 version to 4.x, previous conversations and long-term memory become unavailable. Projects, input history, plugin data, and avatars can be recovered manually. Back up first and read the [4.x upgrade data guide](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.en.md).** This notice concerns crossing into 4.x, not data loss on every 4.x update.

**Plugin compatibility change in this release:** user plugin installations no longer have the old nested `package/` directory. Existing user plugins show a loading error until you reinstall the same plugin ID with replacement confirmed. Leave **Delete plugin data** unchecked to keep business data, configuration, and home location. Old installation settings are not migrated automatically; a missing new settings file defaults to enabled with the titlebar icon hidden. Built-in plugins are unaffected by this layout change.

- Combine file changes and plugin entries in a workspace menu grouped by the current project and plugins, with a settings gear beside the plugin heading. Optional titlebar launch icons can be enabled per plugin and are hidden by default.
- Simplify Notepad: remove the heading, align the sidebar Save button to the right, and use the titlebar save action in separate windows. Unify button appearance and interaction states in light and dark themes.
- Install user plugins directly under `plugins/<id>/` and store installation settings in `db/plugins/<id>/anas-installation.json`. Replacement preserves enabled state and titlebar preference; uninstalling and reinstalling resets them. Improve transaction rollback and interrupted-operation recovery for code, installation settings, and business data.
- Ship four independently installable plugin example ZIPs while retaining source directories in the repository. Refresh the complete example tree at startup and after backup restore without replacing installed copies.
- Add Chinese and English 4.x upgrade data guides, available offline from the user guide, covering affected data, backups, manual recovery paths, and cleanup of old files.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/README.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/README.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
