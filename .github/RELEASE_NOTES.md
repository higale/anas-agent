## Anas v3.1.2

**数据兼容性提示：** 本版以显式 `v0` 为应用数据格式原点，此前无版本和旧编号的数据、备份不自动升级。首次启动可能进入恢复页，可点击“修复”抢救配置、项目及关联数据库、输入历史和头像；修复前保全原始数据，未恢复内容会明确报告。自定义工具 `TOOL.json` 和语言包也须符合当前 `v0` 格式，不属于恢复页的修复范围。

**Data compatibility:** This release establishes explicit `v0` as the application data baseline. Earlier unversioned or differently numbered data and backups are not upgraded automatically. Startup may open recovery, where **Repair** can salvage configuration, projects and associated databases, input history, and avatars. Originals are preserved first, and unrecovered content is reported. Custom-tool `TOOL.json` manifests and language packs must also use their current `v0` format; recovery does not repair those files.

- 工具页合并内置工具入口，右侧按能力分组；MCP 保持独立并按服务器分组。
- 自定义工具新增系统与外加目录来源，复用技能页的目录树和文件预览；项目工具仅在项目设置中展示，能力选择按来源分组。
- 外加目录支持引用、重命名、排序与移除；导入入口仅在选中用户来源时显示，复制到用户目录。
- `file_sha256` 和 `json_format` 从导入示例移入系统工具，在能力设置中选中即可使用。
- 应用自有数据格式统一以显式 v0 为新基线，补齐配置、工具包及辅助数据版本；新增独立迁移框架，供从 v0 开始的后续格式升级使用。
- 恢复页将版本不匹配视为可修复的数据错误，始终为出错文件提供修复入口；先保全原文，再抢救配置、项目及关联数据库。单库损坏不阻断其他数据抢救，剩余问题逐项报告，项目替换支持失败回滚。输入历史和头像配置在进入主界面前检查并纳入同一修复流程。
- 修复可逐条抢救混有坏条目的输入历史，保留原文并报告部分结果；无对应删除日志的暂存文件不再阻断项目修复。头像检查扩展到图片及衍生资产，修复使用仍可读取的图像并通过资产事务重建，不静默换成默认头像；备份导入在替换数据前校验头像参数。

- Combined built-in tools into one entry with capability groups; MCP remains separate with server groups.
- Added system and external custom-tool sources with shared Skill directory-tree and file-preview interactions. Project tools remain in project settings; capability choices are grouped by source.
- External directories support references, display names, ordering, and removal; import appears only for a selected user source and creates user copies.
- Moved `file_sha256` and `json_format` from importable examples into system tools, available by selecting them in capability settings.
- Established explicit v0 as the new baseline for application-owned data, including configurations, tool packages, and supporting records. Added an independent migration framework for future format upgrades starting from v0.
- Recovery treats version mismatches as repairable data errors and keeps repair available for every affected file. Originals are preserved before salvaging configuration, projects, and associated databases. A damaged database does not block independent repairs; unresolved issues are reported and project replacement supports rollback. Input history and avatar configuration are checked before the main interface opens and use the same recovery flow.
- Repair salvages readable input-history entries alongside invalid ones, preserving originals and reporting partial results. A staged deletion file without its journal no longer blocks project repair. Avatar checks include images and derived assets; repair uses surviving images through the asset transaction without silently switching to the default avatar. Backup imports validate avatar parameters before replacing data.

## Downloads / 下载

- **macOS Apple Silicon (ARM64)**: `Anas-<version>-macos-arm64.dmg`
- **macOS Intel (x64)**: `Anas-<version>-macos-x64.dmg`
- **Windows x64**: `Anas-<version>-windows-x64.zip`

macOS: open the DMG and drag Anas into Applications. These builds use ad-hoc signing and are not notarized by Apple. macOS may require approval in **System Settings > Privacy & Security > Open Anyway** after the first launch attempt.

macOS：打开 DMG，将 Anas 拖入“应用程序”。应用采用 ad-hoc 签名，未经过 Apple 公证。首次尝试启动后，可能需要在“系统设置 > 隐私与安全”中选择“仍要打开”。

If download quarantine still blocks the app, first confirm that you trust this GitHub release and compare the DMG's `shasum -a 256` output with `SHA256SUMS.txt`. Then run the following command on the installed copy (adjust the path if needed):

如果下载隔离仍阻止启动，先确认信任此 GitHub Release，并将 DMG 的 `shasum -a 256` 结果与 `SHA256SUMS.txt` 对照，再对安装后的应用执行（如安装位置不同，请修改路径）：

```bash
xattr -r -d com.apple.quarantine "/Applications/Anas.app"
```

Use `sudo` only for a permissions error after checking the path. This removes quarantine, not signature damage; if signature verification fails, download a fresh copy. Do not use it to bypass a malware warning. The app is already ad-hoc signed; manual `codesign --force --deep --sign -` is not a normal installation step.

仅在权限不足且确认路径正确时加 `sudo`。此命令只移除隔离标记，不修复签名损坏；签名校验失败请重新下载，不要用它绕过恶意软件警告。应用已完成 ad-hoc 签名，正常安装无需手动执行 `codesign --force --deep --sign -`。

References / 参考：[Apple: Open Anyway / 仍要打开](https://support.apple.com/102445) · [Apple: deep signing guidance / 深度签名说明](https://developer.apple.com/library/archive/technotes/tn2206/).

Windows: extract the ZIP and run `Anas/Anas.exe`. Keep the complete folder together; no installation is required. Application data uses the normal Anas data directory.

Windows：解压 ZIP，运行 `Anas/Anas.exe`。保留完整文件夹，无需安装；用户数据仍保存在 Anas 默认数据目录中。

`SHA256SUMS.txt` contains checksums for all three downloads.

`SHA256SUMS.txt` 包含上述三个下载文件的校验值。
