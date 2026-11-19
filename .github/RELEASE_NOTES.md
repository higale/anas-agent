## Anas v5.2.17

- 修复已有对话发送消息后迟迟不上屏的问题：已保存的消息和附件在运行准备期间即可显示，开始执行后不会重复；刷新显示失败不再把已成功提交的消息误报为发送失败。
- MCP 启动和后台重连不再阻塞聊天，每轮使用当前已连接的工具；连接成功后供后续轮次使用，手动重载仍等待连接结果。补充中英文使用说明。

- Show saved messages and attachments in existing conversations while execution is still preparing, without duplicating them when execution starts. A display refresh failure no longer reports an accepted submission as a failed send.
- Keep MCP startup and background reconnection from blocking chat. Each turn uses currently connected tools; newly connected servers become available to later turns, while manual reloads still wait for connection results. Update the Chinese and English guides.
