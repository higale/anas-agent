## Anas v5.2.9

- 修复 Windows 日志窗口的中文乱码，支持中文及含特殊字符的日志路径，历史日志和实时追加内容统一按 UTF-8 显示。
- Windows 开发启动脚本启用 UTF-8 代码页，避免开发控制台中的中文乱码。

- Fix garbled Chinese text in the Windows runtime log viewer. Read both existing and newly appended logs as UTF-8, including log paths with Chinese or special characters.
- Enable the UTF-8 code page in the Windows development launcher to display Chinese console output correctly.
