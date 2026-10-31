## Anas v5.0.6

- 长对话中的推理、工具调用等活动按需分批加载；收起整轮或详情时释放对应界面与展示内存，减少长时间浏览的负担。
- 上下滚动时自动加载更多活动，并释放远处的内容；再次滚回时恢复记录，完整历史和模型上下文保持不变。
- 已完成轮次从最开始的活动展开，执行中的轮次从最新活动展开；修复展开时重复加载和位置跳动。
- 修复右侧“到最前／到最后”按钮只到当前已加载边缘的问题，连续点击或同时有新输出时也能正确定位。
- 改善大段工具结果展开时的流畅度，并修复实时输出、分页和子任务同时更新时可能出现的遗漏、重复或相互干扰。

**从 5.0.2～5.0.5 升级无需重置项目或会话。**

- Load reasoning, tool calls and other activities in long conversations in smaller batches as needed. Collapsing a turn or its details releases the corresponding interface and display data from memory.
- Load more activities while scrolling in either direction and release distant content, restoring it when you return. Full conversation history and model context remain intact.
- Open completed turns at their earliest activities and active turns at their latest activities. Fix duplicate loading and unexpected jumps when expanding a turn.
- Make the sidebar's first/last buttons reach the actual beginning or end, including during repeated clicks and incoming output.
- Improve responsiveness when opening large tool results and fix missing, duplicated or mixed activities during simultaneous live updates, pagination and subagent activity.

**Upgrading from 5.0.2–5.0.5 does not require resetting projects or conversations.**

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
