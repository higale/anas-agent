## Anas v4.0.1

**升级提醒：从 4.0 之前的版本升级到 4.x 会丢失旧对话记录和长期记忆。旧项目、输入历史、插件数据及头像需要按说明手动恢复；不提供自动迁移，也不支持导入旧版备份。升级前请备份，具体影响与恢复方法见 [4.0.0 发布说明](https://github.com/higale/anas-agent/releases/tag/v4.0.0)。** 此提醒针对跨入 4.x 的升级，4.0.0 升级到 4.0.1 没有新增的数据丢弃。

- 修复调整侧边栏宽度等无关设置触发用量仪表刷新的问题。展开视图与紧凑视图共用完整悬停详情，更新时间收入详情，移除独立详情图标。

- “检测系统环境”在记住的光标位置插入结果，有选区时替换选区；检测期间内容已被修改时保留用户修改并提示。

- 模型设置列表与模型选择器统一为双行展示，显示上下文、输出限制、压缩阈值和能力；“未选择／跟随父 Agent”移到菜单底部，满宽居中。

- 移除“新会话使用模型”设置，统一按项目模型、全局默认、上次选择、未选择的顺序选择；项目提示词和请求预览遵循相同顺序。

- 默认项目仅名称不可修改，目录、提示词、编码模式和能力等设置与普通项目一致。新建默认项目直接使用系统“文档”目录，不创建额外子目录；保留已保存的目录选择。

**Upgrade notice: upgrading from a version before 4.0 to 4.x loses previous conversations and long-term memory. Previous projects, input history, plugin data and avatars require manual recovery; there is no automatic migration or import of pre-4.0 backups. Back up first and see the [4.0.0 release notes](https://github.com/higale/anas-agent/releases/tag/v4.0.0) for the impact and recovery instructions.** This notice applies when moving to 4.x; upgrading from 4.0.0 to 4.0.1 introduces no additional data loss.

- Fix unnecessary usage-meter refreshes caused by sidebar resizing and unrelated settings. Expanded and compact views share complete hover details, including the last update time, without a separate details icon.

- Insert detected system environment information at the remembered caret position, replacing selected text when present. Preserve edits made while detection is running and show a notice.

- Unify model settings and selection lists with two-line entries showing context, output limits, compression thresholds and capabilities. Center the full-width Not selected / Inherit parent Agent option in the menu footer.

- Remove the model-selection strategy setting. New conversations use the project model, global default, previous selection, or remain unselected, in that order. Project prompt and request previews follow the same order.

- Allow all default-project settings except its name to be edited, including folders, prompts, coding mode and capabilities. New default projects use the system Documents folder directly; saved folder selections are preserved.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/README.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/README.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
