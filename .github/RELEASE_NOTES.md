## Anas v5.2.3

- 工具参数和返回值中的 JSON 字符串支持缩进显示，保留数字和转义内容；推理、参数与结果展开后提供半透明复制按钮。
- “本回合改动”按记录和运行状态显示：有记录时可用，运行或收尾中暂无记录时置灰，确认无记录后隐藏；按可见回合批量查询，超出读取范围时保持置灰。
- “审批模式”更名为“权限模式”，“跳过审批”更名为“完全访问”，权限行为不变；对话权限菜单增加“详细说明”，在侧栏定位到“工具与授权”。
- 修复原生滚动条事件延迟时可能重新跳回底部的问题，按下滚动条即暂停跟随。

- JSON strings in tool arguments and results are now indented while preserving numbers and escapes. Expanded reasoning, arguments, and results include a translucent copy button.
- The round changes shortcut is enabled when records exist, disabled while execution or cleanup is pending without records, and hidden once the entire round is confirmed empty. Queries are batched for visible rounds, and scopes beyond the reader limit remain disabled.
- Renamed “Approval mode” to “Permission mode” and “Skip approval” to “Full access” without changing permission behavior. The conversation permission menu now includes “Learn more”, opening the guide at “Tools And Approval” in the sidebar.
- Fixed delayed native scrollbar events potentially pulling the reader back to the bottom. Pressing the scrollbar now pauses output following immediately.
