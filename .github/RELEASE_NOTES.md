## Anas v5.1.0

- 在“设置 → 记忆”选择偏好保存方式。默认使用后台提取，需先选择后台模型。也可以使用前台主动记忆，让支持工具调用的聊天模型直接保存偏好。两种模式下都能选择后台模型。
- 开启工作区的记忆能力后，聊天会带入已保存的全局和项目偏好。可在设置中编辑全局记忆，从工作区菜单打开项目记忆，在侧栏或独立窗口预览、编辑 Markdown。模型回复期间编辑了同一份记忆时，会保留最新正文。
- 切换到另一对话并首次成功发言后，后台会整理其他已启用记忆的工作区对话。两种模式共用处理进度。通过“工作区菜单 → 记忆活动”可查看本轮整理结果和模型用量，也可选择是否显示标题栏按钮。
- 修复旧开发版记忆库造成的启动恢复问题，完善备份、修复和重置时对记忆数据的处理。项目设置也修正了插件技能归属和子 Agent 工具授权的显示。

**从 5.0.2～5.0.9 升级无需重置项目或会话。** 旧记忆记录保留在原库中，5.1.0 不再读取或自动迁移。旧用户资料仍在配置中，聊天不再注入这些资料。需要沿用的偏好可手动添加到全局或项目记忆。

- Choose how Anas saves preferences in **Settings → Memory**. Background extraction is the default and requires an explicit model selection. In foreground mode, a chat model that supports tools can save preferences directly. The background model picker is available in both modes.
- Workspaces with memory enabled include saved global and project preferences in chat. Edit global memory in Settings, or open project memory from the workspace menu to preview and edit Markdown in the sidebar or a separate window. Edits made while a chat model is responding take precedence over a stale memory update.
- After you switch chats and send the first message successfully, background extraction checks other eligible workspace chats. Both modes share progress. Open **Workspace menu → Memory activity** to see the current results and model usage, and choose whether to show its title bar button.
- Fix startup recovery when an older development memory database is present and improve how backup, repair and reset handle memory data. Project settings also identify plugin skills and show subagent tool access more accurately.

**Upgrading from 5.0.2–5.0.9 does not require resetting projects or conversations.** Existing memory records remain in the old database. Version 5.1.0 does not read or automatically migrate them. Previous user profile details remain in configuration and are no longer included in chat. Add preferences you want to carry over to global or project memory.

## 较早版本升级 / Upgrading from earlier versions

- 从 5.0.1 或更早版本跨越 5.0.2 升级，需要重置全部项目与会话。5.0 不支持导入旧版对话、记忆、运行记录或整包备份；兼容配置与扩展资源的手动复制方式见 [5.0 升级说明](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_5.zh-CN.md)。
- 从 4.0 之前的版本跨入 4.x 时，历史数据目录有变化，见 [4.x 升级说明](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.zh-CN.md)；其中的数据库恢复方法不适用于 5.0。

- Upgrading from 5.0.1 or earlier across the 5.0.2 boundary requires resetting all projects and conversations. Version 5.0 cannot import older conversations, memories, run history or full backups. See the [5.0 upgrade guide](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_5.en.md) for manually copying compatible settings and extensions.
- Moving from a version before 4.0 into 4.x also involves historical data folder changes. See the [4.x upgrade guide](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.en.md); its database recovery instructions do not apply to 5.0.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.zh-CN.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
