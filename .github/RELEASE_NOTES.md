## Anas v5.2.24

- 统一项目与对话入口，移除简易对话模式，创建入口统一为“新建对话”。编码模式独立选择，不再切换项目图标。
- 新建和编辑项目时，目录可以留空，使用“设置 → 对话”中的项目默认目录；设置支持直接编辑和内嵌图标选择，清空后使用系统文档目录。项目保持空目录列表，不自动写入默认路径；修复保存默认目录后项目窗口提示未及时刷新的问题。
- 项目名称留空时自动使用“未命名项目1、2、3…”中尚未占用的名称，输入框直接显示当前可用名称。空目录区域统一展示添加入口和默认路径，整块可点击。
- 项目定义仍为 v0，数据库结构不变，不增加迁移。原简易项目保留名称、提示词、模型选择与对话；缺失能力设置默认全开、编码模式默认关闭，缺失目录跟随全局默认目录。可在项目设置中关闭不需要的能力。

- Unify projects and conversation entry points, removing simple-chat mode. Use a single New conversation entry; coding mode remains a separate choice and no longer changes the project icon.
- Allow folders to stay empty when creating or editing projects, following the default project directory in Settings → Conversation. Edit the path directly or use its inline folder icon; clearing it uses the system Documents directory. Projects retain an empty folder list instead of saving the resolved path. Fix stale directory hints after saving the default setting.
- Automatically choose the first available “Untitled project 1, 2, 3…” name when the name is blank, and show that name in the input placeholder. The entire empty-folder area opens the picker, with an add action and default-path hint.
- Project definitions remain v0, with no database schema changes or new migrations. Former simple-chat projects retain their names, prompts, model selections and conversations. Missing capability settings enable all available capabilities, coding mode defaults to off, and missing folders follow the global default directory. Disable unwanted capabilities in project settings.
