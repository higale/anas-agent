## Anas v4.0.5

**升级提醒：从 4.0 之前的版本升级到 4.x，旧对话和长期记忆不再可用；项目、输入历史、插件数据和头像可手动恢复。升级前请备份，详见 [4.x 升级数据说明](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.zh-CN.md)。** 此提醒针对跨入 4.x 的升级，并非每次 4.x 升级都会丢失数据。

**本次子 Agent 配置不兼容旧版：** `config/subagents.json` 改为 v1，不迁移原 v0 数组配置；旧文件会保留并在启动时提示错误，含旧格式的备份不能直接恢复。请先完全退出应用，把旧文件移到数据目录之外保留，再启动并重新创建或导入子 Agent 包。不要只修改版本号。其他配置、现有对话和记忆不受这项变更影响。[子 Agent 使用与处理说明](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.zh-CN.md#子-agent)

- 子 Agent 改用目录包，定义保存为 `AGENT.json`，提示词通过文件树中的 `PROMPT.md` 编辑；支持外部目录引用、同来源排序和多个包批量导入，批次存在冲突或无效包时整体停止。
- 子 Agent 可携带私有 `skills/` 和 `tools/`，在能力设置中逐项选择；项目可限制其使用范围，私有资源不进入主 Agent 或全局资源列表。
- 仅保留只读内置 `general-purpose`，固定使用父 Agent 模型、能力全开且仍受全局和项目限制；`web-researcher`、`project-analyst` 改为按需导入的可编辑示例。新建自定义 Agent 默认停用、能力全关。
- 统一技能、工具、子 Agent、MCP 和模型设置中的新建、导入、目录及列表操作入口，完善操作提示；项目设置新增本地技能与工具的只读清单。
- 用量仪表统一使用固定厂商与额度类型标题，不再拼接用户设置的供应商名称。

**Upgrade notice: when upgrading from a pre-4.0 version to 4.x, previous conversations and long-term memory become unavailable. Projects, input history, plugin data, and avatars can be recovered manually. Back up first and read the [4.x upgrade data guide](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.en.md).** This notice concerns crossing into 4.x, not data loss on every 4.x update.

**Breaking subagent configuration change:** `config/subagents.json` now uses v1; the previous v0 array format is not migrated. Old files are preserved and reported as a startup error, and backups containing that format cannot be restored directly. Fully quit the app, move the old file outside the data directory for safekeeping, then restart and recreate or import subagent packages. Do not just change the version number. Other settings, existing conversations, and memory are unaffected by this change. [Subagent setup and recovery instructions](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.en.md#subagents)

- Store subagents in directory packages with an `AGENT.json` definition and a `PROMPT.md` prompt editable through the file tree. Support external directory references, ordering within a source, and batch imports that stop as a whole on conflicts or invalid packages.
- Allow subagents to carry private `skills/` and `tools/` with individual capability selections and project limits. Private resources stay out of the main Agent and global catalogs.
- Keep only `general-purpose` built in and read-only, using the parent Agent's model with all capabilities enabled, subject to global and project limits. Provide `web-researcher` and `project-analyst` as optional editable examples. New custom Agents start disabled with all capabilities off.
- Unify creation, import, directory, and list actions across skill, tool, subagent, MCP, and model settings, with clearer action hints and read-only inventories of local skills and tools in project settings.
- Use fixed provider and quota-type titles in Usage Meter instead of appending user-configured provider names.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.zh-CN.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
