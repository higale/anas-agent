## Anas v3.3.0

- 项目支持自定义压缩提示词，使用标签切换编辑项目提示词与压缩提示词；菜单可预览完整提示词、压缩模板和模型请求。关闭定制能力时，项目自定义提示词不生效。
- 模型编辑改为保存／取消，取消时丢弃草稿；精简标题区并统一能力选项的分段多选样式。
- 默认项目仅允许修改图标和模型，其余使用默认设置；修复目录异常和旧项目名称冲突对项目管理的影响。项目文件夹区域采用紧凑、稳定的两行布局。
- 合并技能创建与安装说明为 `skill-manager`，将自定义工具技能统一命名为 `tool-manager`；同步中英用户指南并新增编码模式说明。
- 优化技能设置的分段多选交互，统一预览与源码编辑器的滚动条样式。新增可选压缩配置在缺失时使用默认模板，保持现有 v0 配置可读。

- Customize project compression prompts in tabs alongside project instructions, with menu previews for full prompts, compression templates, and model requests. Project prompt overrides are inactive when capability customization is off.
- Save or cancel model edits explicitly, discarding cancelled drafts. Simplify the editor header and use consistent segmented multi-select controls for model capabilities.
- Limit the default project to icon and model edits while using application defaults elsewhere. Fix project management failures caused by an unavailable default directory or existing name collisions. Use a compact, stable two-row project-folder area.
- Merge skill creation and installation guidance into `skill-manager` and rename the custom-tool skill to `tool-manager`. Update both user guides and add coding-mode documentation.
- Refine segmented multi-select interactions in skill settings and align preview/editor scrollbars. Missing optional compression settings use the default template, keeping existing v0 configuration readable.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/README.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/README.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
