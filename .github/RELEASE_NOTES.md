## Anas v5.2.13

- 修复面板和插件页面对输入法 Esc 的判断：组合状态标记已清除、事件仍标记为输入法处理时，不再误触发侧栏收起；普通 Esc 行为保持不变。

- Fix IME Escape handling in panels and plugin pages. Events still marked as IME input no longer collapse the sidebar after the composition flag clears; ordinary Escape behavior is preserved.
