## Anas v3.0.7

- 子 Agent 和技能能力统一为“使用默认／自定义／关闭”，覆盖全局设置、项目和子 Agent；仅自定义模式展开条目，切换模式保留具体选择。
- 启动恢复按当前能力配置格式逐项校验，保留合法的关闭状态，错误配置项恢复对应默认值，不因局部能力错误重置整个文件、项目或会话。
- **配置变化**：子 Agent 选择移入 `capabilities.subagents`，技能移除 `enabled` 字段，统一使用三态 `mode`。本次不转换旧格式；升级后如进入启动恢复，请选择“修复”。无法识别的值将恢复默认，修复后请检查能力选择；原始数据会先备份。无效选择列表恢复该列表的默认值。

- Subagent and skill capabilities now use **Use defaults / Custom / Off** across global settings, projects, and subagents. Lists appear only in Custom mode, and switching modes retains selections.
- Startup recovery validates capability settings field by field against the current format, preserves valid Off selections, and restores invalid settings to their defaults without resetting entire files, projects, or conversations for local capability errors.
- **Configuration change**: subagent selections move into `capabilities.subagents`; skills drop `enabled` and use the same three-state `mode`. This release does not convert the old format. If startup recovery appears after upgrading, choose **Repair** and review capability selections afterward: unrecognized values use defaults, invalid selection lists use the list default, and original data is backed up before changes.

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
