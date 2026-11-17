## Anas v5.2.12

- 向当前可见插件页面转发原生窗口的鼠标离开通知，配合 RDP 0.1.14 修复 macOS 移出并重新进入窗口后持续显示双光标的问题。请同时更新宿主和插件。
- 移除插件工具栏菜单按钮右下角的小箭头，避免遮挡插件图标；下拉菜单操作保持不变。

- Forward native window pointer exits to visible plugin pages. Together with RDP 0.1.14, this fixes persistent double cursors after leaving and re-entering a window on macOS. Update both the host and plugin.
- Remove the small arrow overlaid on plugin toolbar menu icons. Dropdown menu behavior is unchanged.
