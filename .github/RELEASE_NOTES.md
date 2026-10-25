## Anas v4.0.9

**升级提醒：从 4.0 之前的版本升级到 4.x，旧对话和长期记忆不再可用；项目、输入历史、插件数据和头像可手动恢复。升级前请备份，详见 [4.x 升级数据说明](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.zh-CN.md)。** 此提醒针对跨入 4.x 的升级，并非每次 4.x 升级都会丢失数据。

**子 Agent 配置提醒（4.0.5 起）：** `config/subagents.json` 使用 v1，不兼容、不迁移原 v0 数组配置；旧文件保留并在启动时提示错误，含旧格式的备份不能直接恢复。请完全退出应用，把旧文件移到数据目录之外保留，再启动并重新创建或导入子 Agent 包。不要只修改版本号。已有 v1 配置不受影响。[子 Agent 使用与处理说明](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.zh-CN.md#子-agent)

- 修复手动朗读和自动朗读无声的问题：更新 Edge Read Aloud 服务地址与 Sec-MS-GEC v2 认证，恢复语音合成；保留现有音色、语速和自动朗读设置。

**Upgrade notice: when upgrading from a pre-4.0 version to 4.x, previous conversations and long-term memory become unavailable. Projects, input history, plugin data, and avatars can be recovered manually. Back up first and read the [4.x upgrade data guide](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.en.md).** This notice concerns crossing into 4.x, not data loss on every 4.x update.

**Subagent configuration notice (since 4.0.5):** `config/subagents.json` uses v1; the previous v0 array format is neither supported nor migrated. Old files are preserved and reported as a startup error, and backups containing that format cannot be restored directly. Fully quit the app, move the old file outside the data directory for safekeeping, then restart and recreate or import subagent packages. Do not just change the version number. Existing v1 configurations are unaffected. [Subagent setup and recovery instructions](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.en.md#subagents)

- Fix silent manual and automatic read-aloud by updating the Edge Read Aloud endpoint and Sec-MS-GEC v2 authentication to restore speech synthesis. Existing voice, speed and automatic read-aloud settings are preserved.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.zh-CN.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
