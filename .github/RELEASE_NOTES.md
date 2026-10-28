## Anas v5.0.1

- 重设严格授权、智能审核和完整访问三档权限，默认智能审核。严格授权允许可验证的只读操作、项目与临时目录写入，以及已开启的 Skill 免审；智能审核额外允许桌面、下载、文稿和图片目录内的写入。
- 仅智能审核的内置写入类 JSON 工具声明必填 `needs_approval`，统一说明要求每次显式填写；本地漏传仍按 `true` 处理，代码确认只读或安全目录的操作优先免审。切换权限后按实际派发时的模式重新检查。
- 工具详情与模型实际请求共用定义，可切换权限档位并分别查看 `apply_patch` 的 JSON / Freeform 格式；移除发给模型的冗余 `$schema` 元数据。Freeform 语法保持不变，按代码检查文件目标。
- 修复新建智能审核对话时的 SQLite 约束错误。目录索引 catalog 升为 v2，会话数据库仍为 v1；启动校验版本、字段和权限约束，异常通过先保全、后手动修复处理，不自动转换。
- 分离“重置会话数据库”和“重置全部项目与会话”：前者保留项目定义与设置。确认框展示实际删除清单，目录明确包含全部内容，清单变化时停止操作。

- Redesign Strict approval, Smart approval and Full access, with Smart approval as the default. Strict approval exempts verified reads, writes inside project and temporary directories, and enabled Skill rules; Smart approval additionally exempts writes inside Desktop, Downloads, Documents and Pictures.
- Only Smart approval declares `needs_approval` as required for built-in JSON tools that can write. Shared instructions require an explicit decision on every call; local omission still defaults to `true`, while code-verified read-only and safe-directory operations take priority. Recheck the current mode when dispatching queued calls.
- Share tool definitions between Settings previews and actual model requests. Inspect permission modes and JSON / Freeform `apply_patch` separately, and remove redundant `$schema` metadata from model-facing definitions. Freeform syntax remains unchanged and file targets are checked by code.
- Fix the SQLite constraint failure when starting a Smart approval conversation. The catalog is now v2 while conversation databases remain v1. Validate versions, columns and permission constraints at startup; preserve originals before manual repair, without automatic conversion.
- Separate conversation-database reset from resetting all projects and conversations. Database-only reset retains project definitions and settings. Confirm the actual deletion list, explicitly include directory contents, and stop if the list changes.

**从 5.0.0 升级：** catalog v1 不能直接打开，含旧 catalog 的备份不能直接恢复。启动提示不匹配时请选择修复，不必重置项目；修复后可重新备份。详见 [5.0 升级与修复说明](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_5.zh-CN.md)。

**Upgrading from 5.0.0:** Catalog v1 cannot be opened directly, and backups containing it cannot be restored directly. Choose repair when startup reports a mismatch; resetting projects is unnecessary. Create a new backup after repair. See the [5.0 upgrade and repair guide](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_5.en.md).

**5.0 升级提醒：** 旧数据库和旧版整包备份不兼容；配置与扩展资源的手动复制方法见 [5.0 升级数据说明](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_5.zh-CN.md)。

**历史升级提醒：** 4.0 曾调整数据布局，跨入 4.x 的影响见 [4.x 升级数据说明](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.zh-CN.md)，该说明只适用于 4.x。

**5.0 upgrade notice:** Legacy databases and full backups are incompatible. See the [5.0 upgrade data guide](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_5.en.md) for copying compatible settings and extensions manually.

**Historical upgrade notice:** Version 4.0 changed the data layout. See the [4.x upgrade data guide](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.en.md) for its impact; that guide applies only to 4.x.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.zh-CN.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
