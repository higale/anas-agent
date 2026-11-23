## Anas v5.2.23

- 插件技能统一在插件设置中配置“快捷方式／模型可用”，两项全关即停用，支持技能分组全选／取消全选。插件或依赖工具停用时仍可修改用途；技能页提供只读浏览和所属插件设置入口。
- 技能预览统一到“设置 → 技能”，插件和 MCP 工具详情统一到“设置 → 工具”的对应目录。插件设置中的工具只显示本地名称，与 MCP 设置一致；工具目录和模型调用保留完整名称。插件提示词继续保留原预览入口。
- 插件工具详情保留完整输入参数，并补充操作类型和超时，两项摘要在同一行展示；修复长工具名称的换行和裁切问题。
- 默认对话分组统一隐藏图标，包括自定义图片。项目菜单仅在编码模式开启时显示编码图标，提示文字简化为“编码模式”。
- 配置和数据库格式版本不变。旧插件单技能启用字段 `capability_choices.skill` 被忽略，不迁移原选择、读取不自动写回；已有快捷和模型用途设置继续生效。若此前仅通过旧启用开关停用技能，请在插件设置中关闭其两项用途。

- Configure plugin skills through Shortcut and Available to model in plugin settings. Clearing both disables a skill; group select-all / clear-all controls are retained. Usage choices remain editable while the plugin or a required tool is disabled. The Skills page provides read-only browsing and a link to the owning plugin's settings.
- Consolidate skill previews in Settings → Skills and plugin/MCP tool details in their catalogs under Settings → Tools. Plugin settings now show local tool names, matching MCP settings; catalogs and model calls retain full names. Plugin instruction previews remain available in plugin settings.
- Retain complete input parameters and add operation type and timeout to plugin tool details, with both values on one line. Fix wrapping and clipping of long tool names.
- Hide icons, including custom images, in the default conversation group. Show the project menu's coding icon only when coding mode is enabled, with the tooltip shortened to Coding mode.
- Configuration and database format versions are unchanged. The retired per-skill `capability_choices.skill` field is ignored without migrating its choices or rewriting files on read; existing shortcut and model-use preferences remain effective. If a skill was disabled only through the old enabled switch, clear both usage options in plugin settings.
