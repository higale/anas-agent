## Anas v5.0.9

- 修复展开轮次时“加载中”与正文未对齐的问题，加载、分页提示与轮次内容使用相同的宽度和居中布局。
- 轮次与活动详情的“加载中”延迟 150ms 显示，快速加载时直接呈现内容，减少闪烁；数据请求仍立即开始。
- 收起、切换对象或结束加载时清理旧计时，错误立即显示，重试重新计时。

**从 5.0.2～5.0.8 升级无需重置项目或会话。**

- Align loading and pagination messages with the content when expanding a conversation round, using the same width and centering rules.
- Delay the loading indicator for rounds and activity details by 150ms to avoid flicker on fast reads. Data requests still start immediately.
- Clear pending indicator timers when collapsing, switching resources or finishing a read. Errors appear immediately, and retries start a fresh delay.

**Upgrading from 5.0.2–5.0.8 does not require resetting projects or conversations.**

## 较早版本升级 / Upgrading from earlier versions

- 从 5.0.1 或更早版本跨越 5.0.2 升级，需要重置全部项目与会话。5.0 不支持导入旧版对话、记忆、运行记录或整包备份；兼容配置与扩展资源的手动复制方式见 [5.0 升级说明](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_5.zh-CN.md)。
- 从 4.0 之前的版本跨入 4.x 时，历史数据目录有变化，见 [4.x 升级说明](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.zh-CN.md)；其中的数据库恢复方法不适用于 5.0。

- Upgrading from 5.0.1 or earlier across the 5.0.2 boundary requires resetting all projects and conversations. Version 5.0 cannot import older conversations, memories, run history or full backups. See the [5.0 upgrade guide](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_5.en.md) for manually copying compatible settings and extensions.
- Moving from a version before 4.0 into 4.x also involves historical data folder changes. See the [4.x upgrade guide](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.en.md); its database recovery instructions do not apply to 5.0.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.zh-CN.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
