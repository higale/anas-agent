## Anas v3.3.10

- 优化自动朗读：工具执行、审批和子 Agent 活动不再打断已经开始的朗读；尚未开始的朗读会取消，出现新的主模型正文回复时再切换。
- 新增独立的 `sleep` 等待工具，支持 1–300 秒整数等待与取消，可在项目和子 Agent 能力中单独选择；超过 10 秒仍直接等待，不转为后台任务。
- 等待工具显示时钟图标和紧随文本的倒计时；运行中的工具显示流光效果，适配浅色、深色及减少动态效果设置，同步中英文说明。

- Improve automatic narration: tools, approvals, and subagent activity no longer interrupt speech that has started. Cancel pending speech that has not started, and switch when a new main-model reply begins.
- Add an independent `sleep` tool with cancellable waits of 1–300 whole seconds, selectable in project and subagent capabilities. Waits longer than 10 seconds remain inline instead of becoming background tasks.
- Show a clock icon and an inline countdown for waits, plus shimmer for running tools. Support light and dark themes and reduced-motion preferences, with updated bilingual guides.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/README.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/README.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
