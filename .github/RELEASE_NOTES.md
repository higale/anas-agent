## Anas v5.2.15

- 新增模型级工具图片限制：在“视觉”旁的独立弹窗设置尺寸、比例、字节大小和请求图片数量，默认不限制。数量超限整批省略，其他规则逐图处理，保留原始工具结果并提供省略原因；远端 URL／file ID 不处理。配置和数据库版本不变，已有配置缺少新字段时正常读取。
- 附件支持转为输入框中的原生绝对路径；统一选择和拖放行为，不支持的文件与文件夹直接追加路径，SVG 恢复为文本源码附件。保留会话草稿和历史消息编辑时的临时附件。
- 修复发送、输入历史、Skill 快捷命令及上下文压缩中路径和原始请求的空白丢失，保留 Windows、UNC 和 macOS 路径格式。

- Add per-model tool image limits in a separate dialog beside Vision, with no limits enabled by default. Configure dimensions, aspect ratio, byte size and request image count. Count overflow omits the entire batch; other limits apply per image. Original tool results remain intact and omission reasons are available. Remote URLs and file IDs are left unchanged. Configuration and database versions are unchanged; existing configurations without the new fields remain supported.
- Convert attachments to native absolute paths in the composer. Unify file picker and drag-and-drop behavior, append unsupported files and folders as paths, and restore SVG source-text attachments. Preserve conversation drafts and temporary attachments when editing history.
- Preserve whitespace in paths and original requests across sending, input history, Skill shortcuts and context compression, including Windows, UNC and macOS paths.
