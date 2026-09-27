## Anas v3.1.0

- 子 Agent 支持独立选择模型和参数预设，未选择时跟随父 Agent；清除选择可恢复继承。自定义选择在创建子任务时绑定，已创建任务保留原绑定，失效的模型或预设会明确报错。
- 模型及参数预设选择统一放在子 Agent 的“标识”和项目的“项目名称”标题右侧，便于发现和操作。
- 子 Agent 配置新增可选的 `model_config_id` 和 `model_parameter_preset_id`，未设置这些字段的现有配置继续继承父 Agent；中英文用户指南同步更新。

- Subagents can select their own model and parameter preset, or follow the parent Agent when no model is selected. Clearing the selection restores inheritance. Custom selections bind when a child task is created; existing tasks retain their binding, and unavailable models or presets produce explicit errors.
- Model and preset controls now sit beside the subagent **Identifier** and **Project name** headings for consistent, more visible placement.
- Subagent configuration adds optional `model_config_id` and `model_parameter_preset_id` fields. Existing configurations without these fields continue to inherit from the parent Agent. Chinese and English user guides have been updated.

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
