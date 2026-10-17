## Anas v4.0.0

**4.0 数据变更：升级后，旧项目及其设置、输入历史（含置顶输入）会从界面中消失，可按下述方法手动恢复；旧对话记录及全部长期记忆（含项目记忆）不再保留。** 程序不提供自动迁移，也不支持导入 4.0 之前的备份。全局设置、项目源文件和用户包不变；插件独立数据改放 `db/plugins/`，旧 `plugins_data/` 不自动读取，可手动移动恢复。旧布局文件暂留磁盘，但新版不读取、不自动删除，也不纳入新备份；可通过“数据清理 → 未知文件”查看并清理残留（默认不选中）。

恢复项目和输入历史：建议在开始使用 4.0 创建新数据前，完全退出 Anas，备份原文件，再将数据根目录中的两个文件移入同一数据目录的 `db/`（没有则创建）：

- `projects.json` → `db/projects.json`：恢复项目定义和项目设置。
- `input_history.json` → `db/input_history.json`：恢复输入历史和置顶输入。

这两份文件沿用现有 v0 格式，无须修改内容；重新启动后即可读取。如果 `db/` 中已有同名文件，先另行备份；覆盖会替换新版中的对应数据，不会自动合并。此操作仅恢复项目和输入历史，不恢复旧对话或记忆。

恢复插件数据：完全退出 Anas 并备份后，将原 `plugins_data/` 整体移动为 `db/plugins/`，目录内部结构不变。如果目标目录已存在，先另行备份；整体替换不会合并两边的数据。

头像资源改放 `config/assets/`，旧根目录的 `assets/` 不再读取；未手动恢复时使用默认头像。需要保留自定义头像时，完全退出 Anas 并备份后，将原 `assets/` 整体移动到 `config/assets/`，内部文件无须修改；目标已存在时先另行备份，整体替换，不合并。

- 对话数据库、附件、文件修改恢复材料及长工具结果统一归入 `db/conversations/<主对话ID>/`，主对话与子 Agent 共用目录。
- 项目定义和输入历史使用 `db/projects.json`、`db/input_history.json`；项目重置保留输入历史。
- 会话索引与记忆使用 `db/catalog.sqlite`；临时草稿仍置于 `tmp/`。长工具结果随对话删除，清缓存不影响会话引用。
- 备份、删除重试、数据占用统计和手动修复同步支持新布局。显式删除对话不再要求会话数据库可读，数据缺失、损坏或版本不匹配时也可清理。
- 数据清理隐藏确认为空的项目，新增默认不选中的“未知文件”及路径预览，按独立白名单清理旧布局和其他未知文件；缓存和会话目录由各自清理入口处理。备份默认保存到系统用户文档目录，保留已有目录设置；数据根目录中的备份不在清理白名单内。
- 插件替换、卸载增加事务日志和重启恢复；回滚材料移出临时目录，成功后清理，恢复失败保留文件并提示。
- 技能、工具和插件示例统一放入 `examples/skills/`、`examples/tools/`、`examples/plugins/`；启动及恢复备份时连同说明文件整体更新 `examples/`。导入和安装入口使用新路径，已导入的用户包不受影响。
- 内置技能、工具和插件分别放入 `skills/_system/`、`tools/_system/`、`plugins/_system/`；保留现有 ID 和设置，刷新不覆盖并列的用户包。

**4.0 data change: previous projects and their settings, and input history (including pinned inputs), disappear from the interface after upgrading but can be restored manually as described below. Previous conversations and all long-term memory, including project memory, are no longer retained.** No automatic migration or import of pre-4.0 backups is provided. Global settings, project source files and user packages remain unchanged. Independent plugin data now lives in `db/plugins/`; the old `plugins_data/` directory is not loaded automatically and can be moved manually to restore it. Old-layout files stay on disk for now, but are not read, automatically deleted or included in new backups; review and remove residues through Data cleanup → Unknown files (unchecked by default).

To restore projects and input history, preferably before creating new data in 4.0, fully quit Anas, back up the original files, and move these two files from the data directory root into its `db/` subdirectory (create it if needed):

- `projects.json` → `db/projects.json`: restores project definitions and settings.
- `input_history.json` → `db/input_history.json`: restores input history and pinned inputs.

Both files retain their existing v0 format and need no content changes; restart Anas to load them. If files with the same names already exist in `db/`, back them up separately first. Overwriting replaces the corresponding new data; it does not merge it. This restores only projects and input history, not previous conversations or memory.

To restore plugin data, fully quit Anas, back up your data, and move the entire old `plugins_data/` directory to `db/plugins/` without changing its contents. If the destination already exists, back it up separately first; replacing the directory does not merge the two sets of data.

Avatar resources now live in `config/assets/`. The old root-level `assets/` directory is no longer read, so the default avatar is used until you restore your custom avatar manually. Fully quit Anas and back up your data, then move the entire old `assets/` directory to `config/assets/` without changing its files. If the destination already exists, back it up separately first; replace the directory rather than merging it.

- Group conversation databases, attachments, file-edit recovery material and long tool results under `db/conversations/<main-conversation-ID>/`, shared by the main conversation and its subagents.
- Store project definitions and input history in `db/projects.json` and `db/input_history.json`; project reset preserves input history.
- Store the shared catalog and memory in `db/catalog.sqlite`; keep temporary drafts under `tmp/`. Delete long tool results with their conversation rather than when clearing caches.
- Update backups, deletion retries, storage usage and manual repair for the new layout. Explicit conversation deletion no longer requires a readable conversation database, including missing, damaged or unsupported-version data.
- Hide cleanup categories confirmed to be empty and add an unchecked-by-default Unknown files category with path previews and a maintained allowlist. Cache and conversation directories retain their dedicated cleanup paths. Backups default to the system user's Documents folder while preserving an existing choice; backups inside the data root are not allowlisted.
- Add transaction journals and restart recovery for plugin replacement/removal. Keep rollback material outside temporary storage, clean up completed operations, and preserve files with a visible error when recovery fails.
- Group skill, tool and plugin examples under `examples/skills/`, `examples/tools/` and `examples/plugins/`. Refresh the complete `examples/` tree, including documentation, at startup and after restoring a backup. Import and installation dialogs open these paths; previously imported user packages remain unchanged.
- Store built-in skills, tools and plugins in `skills/_system/`, `tools/_system/` and `plugins/_system/`. Keep existing IDs and settings, and preserve adjacent user packages during refreshes.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/README.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/README.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
