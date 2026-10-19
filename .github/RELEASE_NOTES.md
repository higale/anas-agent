## Anas v4.0.4

**升级提醒：从 4.0 之前的版本升级到 4.x，旧对话和长期记忆不再可用；项目、输入历史、插件数据和头像可手动恢复。升级前请备份，详见 [4.x 升级数据说明](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.zh-CN.md)。** 此提醒针对跨入 4.x 的升级，并非每次 4.x 升级都会丢失数据。

- 侧栏按“项目、简单对话、默认”分组，默认项目独立置底；统一分组标题样式，收起时显示三角，展开时在悬停分组区域或键盘聚焦时显示。
- 项目和对话支持拖动排序并保存顺序；限定在同组和相同置顶状态内，按 Esc 可取消，消息更新不打乱手动排序。
- 对话置顶改用右侧图钉标记，悬停时切换为更多菜单，与项目置顶样式区分。
- 插件页面新增本机目录选择与文件定位接口，供插件实现保存文件和在系统文件管理器中显示；等待目录选择期间不占用应用数据锁。
- 精简中英文 README，加入对应语言的界面截图和插件开发入口；详细使用、开发与打包说明归入专门文档。

**Upgrade notice: when upgrading from a pre-4.0 version to 4.x, previous conversations and long-term memory become unavailable. Projects, input history, plugin data, and avatars can be recovered manually. Back up first and read the [4.x upgrade data guide](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.en.md).** This notice concerns crossing into 4.x, not data loss on every 4.x update.

- Organize the sidebar into Projects, Simple Chats, and Default, keeping the default project at the bottom. Unify group headings; show collapsed indicators persistently and expanded indicators on group hover or keyboard focus.
- Add persistent drag ordering for projects and conversations within the same group and pin state. Press Esc to cancel; message updates do not disturb manual ordering.
- Show pinned conversations with a right-side pin that changes to the More menu on hover, distinguishing them from pinned projects.
- Add directory selection and file reveal APIs for plugin pages. Directory dialogs do not hold the application data lock while waiting for a choice.
- Simplify both READMEs, add localized screenshots and plugin development links, and move detailed usage, development, and packaging instructions into dedicated guides.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.zh-CN.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
