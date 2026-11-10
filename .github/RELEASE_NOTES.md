## Anas v5.2.7

- 项目设置移除“定制能力”总开关，新项目默认能力全开；已有项目直接使用保存的能力、提示词和限制，不转换旧配置。配置与数据库版本不变。
- 支持引用项目自定义技能目录，项目技能统一在技能列表末尾管理，提供快捷、模型与项目级脚本免审选择，并支持点击名称打开目录。
- 统一技能、工具、子 Agent、MCP 和插件的分组折叠与选择控件；MCP／插件总分组支持“全部／定制／关闭”，切换模式保留定制选择，列表随内容自然增高。
- 修复项目与子 Agent 技能范围、同目录多来源选择及快捷调用问题；删除未使用的技能包不再阻断子任务恢复，项目技能编辑保留子 Agent 自带技能授权。
- 统一设置页启用控件与右上角布局、复选图标和间距，保持单选圆点与多选勾选的区分；修复自定义工具启停时页面闪烁、参数视图和文件树状态丢失。

- Remove the project-wide customization switch and enable all capabilities for new projects. Existing projects use their saved capabilities, prompts, and limits directly, without configuration conversion. Configuration and database versions remain unchanged.
- Add custom skill-directory references for projects. Manage project skills at the end of the unified skills list, with shortcut, model, and project-specific script approval controls; click skill names to open their directories.
- Unify collapsible groups and selection controls for skills, tools, subagents, MCP, and plugins. MCP and plugin groups support All / Custom / Off while preserving custom selections; lists expand naturally with their content.
- Fix project and subagent skill scope, selections across sources sharing a directory, and shortcut invocation. Deleting unused skill packages no longer blocks subtask recovery, and editing project skills preserves subagents' bundled-skill selections.
- Standardize top-right enable controls, checkbox icons, and spacing while keeping radio dots distinct from checkbox ticks. Fix custom-tool toggles flickering the page or losing parameter-view and file-tree state.
