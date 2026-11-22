## Anas v5.2.22

- MCP 改为按需启动：程序启动只读取已保存的工具目录，模型调用时再连接，并在对话中显示启动进度。启动失败或工具已移除时，通过原工具调用返回错误。
- MCP 设置新增启动／停止和逐工具开关。手动启动不受启用开关限制，每次成功启动刷新并保存工具目录，空列表会清空旧目录，失败保留旧目录。停止只断开连接；目录和选择独立保存，后续调用仍可启动。没有有效的非空工具列表时不能新启用服务，请先手动启动获取列表。
- 项目和子 Agent 的最终能力条目统一为多列复选框，最外层保留“全部／定制／关闭”，仅顶层可折叠；定制时支持分组全选／全不选。优化列对齐、分组间距、分割线和目录图标，停用原因通过警示色与 tooltip 展示。
- 插件设置支持分别选择工具、技能和提示词，保留各项选择并遵循依赖关系。插件技能同时显示在技能设置中，停用期间仍可修改快捷方式和模型用途。修复配置修改时的闪烁，并统一插件与 MCP 工具的详情预览交互。
- 修复进入设置后快捷输入弹层残留；补齐 MCP 操作失败的中英文提示并保留错误详情，同步界面测试和双语文档。
- 配置和数据库格式版本不变。旧 MCP 配置没有工具目录时需先手动启动发现；新增工具目录、逐工具选择和插件能力字段均有默认值。项目与子 Agent 的旧细选按整项选择读取，不自动写回，已有会话冻结配置保持不变。

- Start MCP servers on demand. Application startup reads saved tool catalogs without connecting; tool calls start the server and show progress in the conversation. Startup failures and removed tools return errors through the original tool call.
- Add Start / Stop and per-tool switches to MCP settings. Manual startup works regardless of the enabled switch. Each successful start refreshes and saves the catalog, including clearing it when discovery returns no tools; failures preserve the previous catalog. Stop only disconnects, while catalogs and selections are saved independently and later calls can reconnect. Start a server to obtain a valid, non-empty tool list before enabling it.
- Use multi-column checkboxes for individual project and subagent capabilities. Keep All / Custom / Off at the top level, allow only top-level sections to collapse, and add group select-all / clear-all actions in Custom mode. Improve column alignment, spacing, dividers and directory icons; show unavailable entries with warning colors and tooltip reasons.
- Add individual tool, skill and prompt switches to plugin settings while preserving choices and respecting dependencies. List plugin skills in skill settings, and allow shortcut and model-use preferences to be edited while a skill is inactive. Fix settings flicker and align plugin and MCP tool previews.
- Dismiss shortcut suggestions when entering settings. Add localized MCP failure messages with diagnostic details, and update UI tests and bilingual documentation.
- Configuration and database format versions are unchanged. Existing MCP configurations without catalogs require one manual start to discover tools; new catalog, tool-selection and plugin-capability fields have defaults. Old project and subagent fine-grained selections are read as whole-item choices without rewriting on read; frozen configurations in existing conversations remain unchanged.
