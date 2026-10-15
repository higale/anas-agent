## Anas v3.3.15

- 新增内置“用量仪表”，按当前模型 API 地址显示 MiniMax、智谱 / Z.ai Coding Plan 额度，智谱国内普通 API、DeepSeek、Moonshot/Kimi 余额，以及 OpenRouter 密钥额度与消费。
- 百炼 / Qwen 中国站通过本机 `bl` 核对账户和密钥，显示 Token Plan 额度及套餐详情，或普通密钥的免费额度与近期用量；仪表内支持登录、切换账户和取消登录。
- 仪表支持紧凑／详细显示、分组悬停详情、重置倒计时、缓存与立即刷新；匹配模型后立即显示加载状态，切换模型或凭据时清除旧读数，窄侧栏优先显示额度数值。
- 插件框架新增侧栏底部 HTML 展示接口，复用宿主样式、主题和声明式按钮操作；完善停用、停止和备份时的生命周期处理，并统一明暗主题提示框。

- Add the built-in Usage Meter for MiniMax and GLM / Z.ai Coding Plan quotas; China GLM ordinary API, DeepSeek and Moonshot/Kimi balances; and OpenRouter key credits and spend, selected by the current model's API URL.
- Integrate Bailian / Qwen China through the local `bl` CLI to verify accounts and keys, show Token Plan quotas and subscription details or ordinary-key free quota and recent usage, and offer sign-in, account switching and cancellation inside the meter.
- Support compact/detailed views, grouped hover details, reset countdowns, caching and manual refresh. Show loading immediately for matching models, clear old readings when models or credentials change, and prioritize quota values in narrow sidebars.
- Extend plugins with sidebar footer HTML widgets using shared host styles, themes and declared button actions; handle disabling, stopping and backups consistently, and align tooltips with light and dark themes.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/README.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/README.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
