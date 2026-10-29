## Anas v5.0.2

- 项目定义与界面状态分开保存，会话及其资源统一归入所属项目目录。
- 完善重置、备份和恢复流程，保持项目与会话的数据边界一致。
- 修复首次对话的初始化顺序，创建会话目录前先初始化或校验项目。
- 修复项目目录或状态缺失导致无法启动的问题。手动修复先保全原始数据，尽量抢救有效内容，隔离无法恢复的内容并验证程序可重新进入。

**数据说明：升级后需要重置全部项目与会话。**

- Store project definitions separately from UI state, with conversations and their resources organized under each project.
- Update reset, backup and restore flows to use consistent project and conversation boundaries.
- Initialize or validate the project before creating a conversation directory, fixing first-conversation startup.
- Fix startup failures caused by missing project directories or state. Manual repair preserves the originals, salvages usable content, isolates unrecoverable content, and verifies that the application can reopen.

**Data notice: After upgrading, reset all projects and conversations.**

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.zh-CN.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
