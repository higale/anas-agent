## Anas v3.1.1

- 新增系统技能 `tool-creator`，指导模型创建、修改和排查 Anas 自定义工具，附工具格式参考和可运行的 Python 模板。
- 新增百度 AI 搜索示例工具，支持通过环境变量配置密钥，提供参数校验、超时控制、错误诊断和中英使用说明。
- 修复 Edge TTS 命令行备用路径无法正确传递负数语速、音量及音调的问题。
- 修复照片搜索在父子目录或其他重叠范围中重复计数、重复结果占用扫描和返回数量上限的问题。
- 文本读取、文件 SHA-256 和 JSON 格式化示例的工具描述、参数说明及 README 改为英文；百度搜索保留中文工具说明。

- Added the bundled `tool-creator` Skill for creating, modifying, and troubleshooting Anas custom tools, with a format reference and a runnable Python template.
- Added a Baidu AI Search example tool with credentials supplied through an environment variable, input validation, timeout handling, error diagnostics, and Chinese and English setup instructions.
- Fixed negative speech rate, volume, and pitch values being passed incorrectly through the Edge TTS command-line fallback.
- Fixed duplicate photo counts and duplicate matches consuming scan and result limits when searching parent/child folders or other overlapping roots.
- Changed tool descriptions, parameter help, and READMEs for the text-reading, file SHA-256, and JSON-formatting examples to English. Baidu AI Search retains Chinese tool descriptions.

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
