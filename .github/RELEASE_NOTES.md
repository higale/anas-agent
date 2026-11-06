## Anas v5.2.2

- 置顶项目汇总到侧栏最上方的独立分组，支持折叠和跨项目类型排序，并移除项目左上角的置顶标记。
- 修复混合手动与自动排序时，新置顶项目未排在组首的问题，并立即刷新侧栏顺序。
- 开启自动压缩时，上下文使用率以压缩点为分母；关闭时以可用上下文为分母，数字、圆环、进度条和明细比例保持一致。

- Pinned projects now appear in a separate group at the top of the sidebar, with collapsible contents and ordering across project types. Removed the corner pin marker.
- Fixed newly pinned projects not appearing first when manual and automatic ordering were mixed, and refresh the sidebar order immediately.
- Context usage now uses the compression point as its denominator when automatic compression is enabled, or usable context when disabled. The percentage, ring, progress bar, and detail ratios stay consistent.
