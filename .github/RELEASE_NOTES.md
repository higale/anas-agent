## Anas v4.0.7

**升级提醒：从 4.0 之前的版本升级到 4.x，旧对话和长期记忆不再可用；项目、输入历史、插件数据和头像可手动恢复。升级前请备份，详见 [4.x 升级数据说明](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.zh-CN.md)。** 此提醒针对跨入 4.x 的升级，并非每次 4.x 升级都会丢失数据。

**子 Agent 配置提醒（4.0.5 起）：** `config/subagents.json` 使用 v1，不兼容、不迁移原 v0 数组配置；旧文件保留并在启动时提示错误，含旧格式的备份不能直接恢复。请完全退出应用，把旧文件移到数据目录之外保留，再启动并重新创建或导入子 Agent 包。不要只修改版本号。已有 v1 配置不受影响。[子 Agent 使用与处理说明](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.zh-CN.md#子-agent)

- 修复 Shell 的 `keep_processes` 生命周期：现在可以直接独立启动前台服务命令，启动交接后即结束受管调用；后续消息、取消、轮次清理和应用退出不会终止已交接的进程。交接前仍支持取消和回收。
- 独立启动返回 PID 和 stdout/stderr 日志文件路径，可另行检查服务就绪与输出；已确认的启动结果恢复时不会重复执行。补充 Windows、macOS／POSIX 交接及取消边界的回归覆盖，并更新工具说明和中英文用户指南。
- 修复编码评测的模型绑定与插件数据隔离，按 Codex 的首个匹配和上下文定位规则校正重复文本评测及失败断言；评测报告统一写入忽略的 `tmp/` 目录，并说明符号链接目标的授权与执行规则。

**独立进程行为变更：** `keep_processes: true` 改为独立启动整个命令，无需手动加后台操作；成功返回只表示完成启动交接，不表示命令成功退出或服务就绪。输出保存在系统临时目录，由用户管理进程及日志；此模式不能与 PTY 或正数 `timeout` 同用。[命令执行说明](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.zh-CN.md)

**Upgrade notice: when upgrading from a pre-4.0 version to 4.x, previous conversations and long-term memory become unavailable. Projects, input history, plugin data, and avatars can be recovered manually. Back up first and read the [4.x upgrade data guide](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.en.md).** This notice concerns crossing into 4.x, not data loss on every 4.x update.

**Subagent configuration notice (since 4.0.5):** `config/subagents.json` uses v1; the previous v0 array format is neither supported nor migrated. Old files are preserved and reported as a startup error, and backups containing that format cannot be restored directly. Fully quit the app, move the old file outside the data directory for safekeeping, then restart and recreate or import subagent packages. Do not just change the version number. Existing v1 configurations are unaffected. [Subagent setup and recovery instructions](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.en.md#subagents)

- Fix the Shell `keep_processes` lifecycle: foreground service commands can now launch independently, completing the managed call after ownership handoff. Later messages, cancellation, turn cleanup, and application exit do not stop a handed-off process. Cancellation and cleanup remain available before handoff.
- Return the PID and stdout/stderr log paths so readiness and output can be checked separately; replaying a confirmed launch result does not execute it again. Add Windows and macOS/POSIX handoff and cancellation regression coverage, and update tool descriptions and both user guides.
- Fix model binding and plugin data isolation in coding evaluations. Align repeated-text cases and failure assertions with Codex first-match and context-anchor behavior, store evaluation reports under ignored `tmp/`, and document authorization and execution rules for symbolic-link targets.

**Independent-process behavior change:** `keep_processes: true` now launches the entire command independently without a manual background operator. Success confirms ownership handoff, not successful command completion or service readiness. Output is stored in the system temporary directory; users manage the process and logs. This mode cannot be combined with a PTY or a positive `timeout`. [Command execution guidance](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.en.md)

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.zh-CN.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
