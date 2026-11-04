## Anas v5.1.2

- 备份导出失败时保留原备份。修复高压缩率文件可能无法恢复、目录中的无关文件可能阻止备份的问题。
- 手动和自动压缩对话时，提示词会保留原文中的 `$$`、`$&` 等字符。
- 切换供应商或连续刷新模型列表时，迟到的旧请求不会覆盖当前列表或较新的缓存。

- Failed exports preserve the existing backup. Highly compressible files can be restored, and unrelated directory entries no longer block backups.
- Manual and automatic conversation compression preserve literal text such as `$$` and `$&` in the summarization prompt.
- When switching providers or refreshing repeatedly, late responses no longer overwrite the current model list or a newer cache entry.
