## Anas v5.2.11

- 修复 Windows 独立窗口全屏时标题栏状态更新滞后，避免远程桌面自适应使用错误高度。
- 插件可独立控制系统最大化；窗口工具栏始终提供全屏或适配到尺寸上限的入口，并使用不同图标。
- 修复 Windows 非整数显示缩放下窗口上限多算边框，适配后仍能继续拖大少量像素的问题。

- Fix delayed titlebar state updates when separate windows enter fullscreen on Windows, so remote desktop adaptation uses the correct height.
- Let plugins control system maximization independently. The window toolbar always offers fullscreen or fitting to the size limit, with distinct icons.
- Fix extra resize space caused by counting rounded window borders again under fractional Windows display scaling.
