## Anas v3.3.1

- 设置页使用本地草稿和顺序保存，修复修改能力等选项时的闪烁及连续操作被旧保存结果覆盖的问题。
- 保存失败时保留未保存内容并支持重试；模型供应商切换后可恢复失败草稿，MCP 和子 Agent 连续编辑时避免重复创建或显示已删除条目的草稿。
- 项目可设置新对话的默认工具权限，包括默认项目；对话仍可单独切换，已有对话不受项目默认值变更影响。缺少新字段时使用“允许只读”，保持 v0 配置格式，无需迁移。
- 项目文件夹下方左侧显示工具权限，模型与推理选项靠右对齐；同步中英文说明和权限切换入口文档。

- Use local drafts and sequential saves in settings to prevent flicker and older save responses from overwriting rapid edits.
- Retain unsaved changes after failures and support retries. Restore failed provider drafts when switching back, and prevent duplicate MCP/subagent creation or deleted-item drafts during consecutive edits.
- Configure the initial tool access mode for new conversations per project, including the default project. Conversations can override it, and existing conversations keep their own permissions. Omitted fields use Allow read-only within the existing v0 format, with no migration required.
- Place tool access below project folders on the left and align model and reasoning selections to the right. Update both user guides and document the current permission-switching entry point.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/README.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/README.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
