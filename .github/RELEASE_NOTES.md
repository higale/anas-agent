## Anas v5.2.10

- 修复简单聊天未发送模型配置中服务端工具的问题，支持 Responses 服务端工具及 MCP 与 Agent 本地工具共存。
- 插件独立窗口支持内容尺寸上限，允许手动缩小；上限随应用缩放和标题栏更新，兼容小画面，并修复 macOS 切换自适应时的缩放等待与上限解除。

- Fix simple chat omitting provider-executed tools configured on the model. Responses server tools and MCP can coexist with local Agent tools.
- Add content-size limits for separate plugin windows while allowing manual shrinking. Limits follow application zoom and titlebar changes, support small desktops, and handle macOS zoom transitions and removal of size limits when adaptation changes.
