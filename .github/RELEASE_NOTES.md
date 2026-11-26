## Anas v5.2.28

### 中文

- 修复文件移动和 HTTP 下载在“不覆盖”模式下的并发覆盖问题，保留检查后由其他进程新建的目标文件。
- 加强日志、临时文件和开发日志清理，以及数据恢复回滚的目录链接检查，避免误删或覆盖链接指向的外部文件。退出时由当前进程执行临时文件清理，避免影响下一次启动。
- 修复内置工具和后台调用管理工具将明确失败记录为成功的问题，让会话记录与模型收到的错误状态保持一致。
- 大文本附件按配置的字符上限增量读取，减少读取超大文件时的内存占用。

### English

- Fixed races in file moves and HTTP downloads with overwrite disabled, preserving destination files created by another process after the initial check.
- Added directory link checks to log, temporary-file and development-log cleanup, and to data restore rollback, preventing accidental deletion or replacement of external files. Temporary-file cleanup now stays in the exiting process so it cannot affect the next launch.
- Fixed explicit failures from built-in tools and background call management being recorded as successful, keeping conversation history and model-visible error status consistent.
- Large text attachments are read incrementally up to the configured character limit, reducing memory use when opening oversized files.
