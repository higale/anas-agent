## Anas v4.0.6

**升级提醒：从 4.0 之前的版本升级到 4.x，旧对话和长期记忆不再可用；项目、输入历史、插件数据和头像可手动恢复。升级前请备份，详见 [4.x 升级数据说明](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.zh-CN.md)。** 此提醒针对跨入 4.x 的升级，并非每次 4.x 升级都会丢失数据。

**子 Agent 配置提醒（4.0.5 起）：** `config/subagents.json` 使用 v1，不兼容、不迁移原 v0 数组配置；旧文件保留并在启动时提示错误，含旧格式的备份不能直接恢复。请完全退出应用，把旧文件移到数据目录之外保留，再启动并重新创建或导入子 Agent 包。不要只修改版本号。已有 v1 配置不受影响。[子 Agent 使用与处理说明](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.zh-CN.md#子-agent)

- 按固定版本的 Codex 上游实现补丁解析与文本匹配，统一上下文、空白、Unicode 标点和换行处理；保留宿主的路径授权、事务、并发冲突检查、撤销和故障恢复，并补充上游授权声明及参考用例对照验证。
- OpenAI Responses 使用原生 Freeform 补丁调用，Chat Completions 和 Anthropic Messages 使用 JSON 参数；两者进入同一补丁处理流程。完善 Freeform 流式参数接收，以及历史 JSON／Freeform 调用的恢复和结果回传。
- 工具调用标题新增紧凑的 `Freeform` 标签，实时与历史记录均可查看，支持中英文说明和明暗主题。
- 供应商模板按 Responses、Chat Completions、Anthropic Messages 分开显示，各自使用对应的 API 地址；补充 GLM Responses 等模板，并完善使用说明。模板更新不覆盖已保存的供应商配置。
- 修复 GLM Responses 的用量面板被隐藏的问题，识别普通 API 的 `/api/v1` 地址并显示账户余额。

**补丁与接口说明：** `apply_patch` 更新后的非空文件会带末尾换行，旧的自定义补丁扩展不再支持；需要精确保留完整文本和末尾换行状态时可使用 `write_file`。JSON 调用支持 `dry_run` 预览，Freeform 调用不携带此参数。Responses 供应商须支持 `custom` 工具；MiMo 的这类工具需要 Responses Lite，本版尚未适配，可选 Chat Completions 或 Anthropic Messages 模板。[模型与工具说明](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.zh-CN.md)

**Upgrade notice: when upgrading from a pre-4.0 version to 4.x, previous conversations and long-term memory become unavailable. Projects, input history, plugin data, and avatars can be recovered manually. Back up first and read the [4.x upgrade data guide](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.en.md).** This notice concerns crossing into 4.x, not data loss on every 4.x update.

**Subagent configuration notice (since 4.0.5):** `config/subagents.json` uses v1; the previous v0 array format is neither supported nor migrated. Old files are preserved and reported as a startup error, and backups containing that format cannot be restored directly. Fully quit the app, move the old file outside the data directory for safekeeping, then restart and recreate or import subagent packages. Do not just change the version number. Existing v1 configurations are unaffected. [Subagent setup and recovery instructions](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.en.md#subagents)

- Align patch parsing and text matching with a pinned Codex revision, including context, whitespace, Unicode punctuation, and newline handling. Retain host path authorization, transactions, conflict checks, undo, and failure recovery, with upstream attribution and reference-case verification.
- Use native Freeform patch calls for OpenAI Responses and JSON arguments for Chat Completions and Anthropic Messages, sharing the same patch processing. Improve streamed Freeform input handling and restore/replay of historical JSON and Freeform tool calls and results.
- Add a compact `Freeform` badge to live and historical tool-call titles, with bilingual hints and support for light and dark themes.
- Separate provider templates by Responses, Chat Completions, and Anthropic Messages, each with the corresponding API endpoints. Add GLM Responses and other templates and clarify usage guidance. Template updates do not overwrite saved provider configurations.
- Fix the hidden Usage Meter for GLM Responses: recognize the ordinary `/api/v1` endpoint and show the account balance.

**Patch and API notes:** Non-empty files updated with `apply_patch` end with a newline, and previous custom patch extensions are no longer supported. Use `write_file` when exact full-text and final-newline preservation is needed. JSON calls support `dry_run` previews; Freeform calls do not carry that parameter. Responses providers must support `custom` tools. MiMo requires Responses Lite for these tools, which this release does not support; use its Chat Completions or Anthropic Messages template instead. [Model and tool guidance](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.en.md)

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.zh-CN.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
