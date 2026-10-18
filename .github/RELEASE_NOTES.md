## Anas v4.0.3

**升级提醒：从 4.0 之前的版本升级到 4.x，旧对话和长期记忆不再可用；项目、输入历史、插件数据和头像可手动恢复。升级前请备份，详见 [4.x 升级数据说明](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.zh-CN.md)。** 此提醒针对跨入 4.x 的升级，并非每次 4.x 升级都会丢失数据。

**自定义工具调整：** 移除系统来源，`file_sha256` 和 `json_format` 改为可选示例。需要继续使用时，从“设置 > 工具”导入对应示例；原有系统工具的定制选择需改选导入的副本。旧 `tools/_system/` 目录可能显示为错误工具，可在工具页删除。

- 模型 API Key 支持从 `.env` 和系统环境变量下拉选择，也可手动填写密钥或 `${变量名}` 引用；下拉只展示变量名称及状态，支持包含空格的变量名。
- “安装技能”移至技能页顶部，成功后自动展开用户分组并定位到安装的技能。
- 统一技能、自定义工具、MCP、插件和子 Agent 的停用状态显示，在列表右侧标注“已停用”，加载错误单独显示。
- 精简随包技能示例，保留天气和 IP 位置查询；工具示例均需导入后使用，导入的副本可以自由编辑。已安装的用户技能不受示例清理影响。
- 使用原生文本框自动高度，修复编辑 `.env` 时页面自动滚动的问题，同时保持换行、窗口缩放和高度限制正常。

**Upgrade notice: when upgrading from a pre-4.0 version to 4.x, previous conversations and long-term memory become unavailable. Projects, input history, plugin data, and avatars can be recovered manually. Back up first and read the [4.x upgrade data guide](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.en.md).** This notice concerns crossing into 4.x, not data loss on every 4.x update.

**Custom tool change:** remove the system source and provide `file_sha256` and `json_format` as optional examples. Import them from Settings > Tools to keep using them, and replace previous system-tool selections in customized capabilities with the imported copies. A leftover `tools/_system/` directory may appear as an invalid tool and can be deleted from the Tools page.

- Allow model API keys to be selected from `.env` or system environment variables, entered directly, or referenced as `${VARIABLE_NAME}`. The dropdown shows only variable names and status, and supports names containing spaces.
- Move Install skill to the top of the Skills page. Successful installation expands the User group and selects and scrolls to the installed skill.
- Show a consistent Disabled label on the right of skill, custom tool, MCP, plugin, and subagent lists, with loading errors displayed separately.
- Reduce bundled skill examples to weather and IP-location queries. All tool examples require import before use, and imported copies are editable. Removing bundled examples does not affect installed user skills.
- Use native textarea sizing to fix page scrolling while editing `.env`, while preserving wrapping, window resizing, and height limits.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/README.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/README.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
