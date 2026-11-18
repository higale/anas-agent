## Anas v5.2.16

- 用户图片附件纳入模型图片限制：添加时检查尺寸、比例和大小，提交前合并检查本次请求图片数量；失败时保留草稿和附件，允许调整后重试。修复图片限制对历史上下文统计和压缩的干扰。
- 附件独立保存原始路径，模型仅接收原始路径，不再附带内部归档路径。历史图片省略数据后仍保留文件名与原始路径，历史编辑和排队消息保留来源信息。
- 会话数据库升级为 v4，启动与恢复备份时自动升级受支持的 v3；旧附件原始路径为空，启动升级前保全原数据库，失败可重试。恢复备份不逐条检查记录内容或附件文件的存在性和大小；catalog、记忆和配置版本不变，不支持降级读取 v4。

- Apply model image limits to user attachments: check dimensions, aspect ratio and size when adding images, then check the combined image count before submission. Keep drafts and attachments after validation failures so they can be adjusted and retried. Fix image-limit checks interfering with history context estimates and compression.
- Store each attachment's original path separately. Models receive only the original path, without internal archive paths. Keep filenames and original paths when omitting historical image data, including after history edits and in queued messages.
- Upgrade conversation databases to v4 automatically from supported v3 databases at startup and during backup restore. Existing attachments have no original path; startup upgrades preserve original databases and can be retried after failure. Backup restore no longer checks individual record contents or attachment existence and sizes. Catalog, memory and configuration versions are unchanged; older versions cannot read v4 databases.
