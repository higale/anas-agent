## Anas v5.2.20

- 移除 Shell 工具的 `keep_processes` 参数。Shell 退出即完成调用；取消、超时和退出 Anas 只停止直接 Shell，不递归关闭其子进程。已交接的长命令可跨轮继续，仍可显式取消。
- 在工作区菜单的项目记忆下方新增“进程列表”，在右侧查看当前对话及子 Agent 启动的 Shell 和已识别直接子进程，支持刷新和按身份手动终止；不混入应用内部后代进程。进程观察为尽力而为，终端关闭仍可能影响连接终端的程序。
- 精简 Windows 和 macOS 的 Shell 返回：无需额外状态时保留原始标准输出，其他结果只附必要字段；不重复发送原始命令或内部进程快照，后台查询重新核验存活进程。
- 统一菜单与侧栏图标，并区分进程列表、项目记忆、记忆活动和对话过程；统一 Python 错误详情，更新双语指南。配置与数据库格式不变；调用 Shell 的扩展需移除旧参数。
- 更新 MCP SDK、Shell 参数解析、参数校验及相关传递依赖，修复上游已公布的安全问题。
- 修复部分 Responses 兼容服务在工具调用后附加空消息导致下一次请求返回 400 的问题；请求省略空占位消息，原始记录和工具结果保留。
- 修复 Windows 原生 Shell 对大小写重复环境变量的处理，保证内置命令所在的 PATH 正确传递。

- Remove `keep_processes` from Shell tools. A call completes when its Shell exits; cancellation, timeout and exiting Anas stop only that Shell, without recursively terminating children. Yielded long-running commands can continue across turns and can still be cancelled explicitly.
- Add **Process list** below **Project memory** in the workspace menu. Inspect Shells and identified direct children from the current conversation and its subagents in the right sidebar, refresh their status, and terminate individual processes after identity checks. Application descendants are excluded. Observation is best-effort, and terminal closure can still affect attached programs.
- Simplify Shell results on Windows and macOS: preserve raw stdout when no extra status is needed, otherwise include only necessary fields. Omit repeated commands and internal process snapshots, and recheck live processes during background queries.
- Share menu and sidebar icon mappings and distinguish processes, project memory, memory activity and conversation activity. Standardize Python error details and update bilingual guides. Configuration and database formats are unchanged; extensions calling Shell tools must remove the old parameter.
- Update the MCP SDK, Shell argument parser, validation library and related transitive dependencies to address published upstream security issues.
- Fix HTTP 400 errors when a Responses-compatible service appends an empty message after tool calls. Omit the empty placeholder from replay requests while preserving original records and tool results.
- Fix case-insensitive environment variable handling in native Windows Shells so the PATH for bundled commands is passed correctly.
