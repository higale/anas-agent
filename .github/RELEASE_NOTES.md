## Anas v3.3.17

- 用量仪表将账户、套餐和余额明细集中到更新时间右侧的详情图标；悬停预览，点击固定后可选择、复制文字，主要读数与必要的异常提示保持可见。
- MiniMax 统一显示“5h 限额”和“周限额”的剩余额度，周读数计入套餐加成；详情补充总额度、已用额度和加成说明，重置倒计时继续直接显示。
- 插件 HTML 展示项支持共享详情浮层，修复跨 Shadow DOM 的悬停交互，并优化提示框宽度和换行。
- 按官网更新 DeepSeek 内置模板：OpenAI Base URL 使用根地址，两种协议的模型列表地址统一为 `/models`；已有供应商配置保持不变。

- Consolidate account, plan and balance details behind an info icon beside the update time. Hover to preview or click to keep details open for text selection and copying; primary readings and important notices remain visible.
- Show MiniMax remaining quota under “5h limit” and “Weekly limit”, including weekly plan boosts. Add total quota, used quota and boost explanations to details while keeping reset countdowns visible.
- Support shared details popovers in plugin HTML widgets, fix hover interactions across Shadow DOM boundaries, and improve tooltip width and wrapping.
- Update built-in DeepSeek templates to the official endpoints: use the root OpenAI Base URL and `/models` for both protocols’ model lists. Existing provider configurations remain unchanged.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/README.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/README.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
