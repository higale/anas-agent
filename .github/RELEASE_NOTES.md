## Anas v3.3.3

- 插件安装支持直接选择 ZIP 或 `PLUGIN.json`；ZIP 自动解包，选择清单则安装它所在的整个目录。
- ZIP 支持清单位于根目录或唯一的顶层文件夹中；校验路径、大小、压缩比、重复条目和 CRC，安装失败清理暂存文件，保留原始文件、已安装插件和数据。
- 更新安装按钮、插件开发文档、示例说明和中英用户文档，补充两种安装入口及失败处理的回归验证。插件配置格式不变。

- Install plugins directly from a ZIP file or `PLUGIN.json`. ZIPs are extracted automatically; selecting a manifest installs its entire folder.
- Support manifests at the archive root or inside its sole top-level folder. Validate paths, sizes, compression ratios, duplicate entries, and CRC checksums. Failed installations clean up temporary files while preserving the source, installed plugins, and saved data.
- Update the install button, developer documentation, examples, and bilingual user guidance, with regression coverage for both installation paths and failure handling. The plugin configuration format is unchanged.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/README.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/README.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
