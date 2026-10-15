## Anas v3.3.14

- 插件设置页支持拖入 ZIP、PLUGIN.json 或插件根目录安装，提供拖放提示，并沿用已有的覆盖确认与安装校验。
- 工具执行时，图标、工具名、说明和状态共用整行流光，点击与展开保持可用；等待确认或执行结束后停止，并遵循系统“减少动态效果”设置。
- 语音按钮按状态显示颜色：加载时蓝色闪烁、播放时绿色闪烁、失败时红色，停止后恢复普通样式。

- Install plugins by dropping a ZIP, PLUGIN.json or plugin root directory onto the plugin settings page, with drop feedback and existing replacement confirmation and validation.
- Apply one continuous shimmer across running tool headers, including icons, names, descriptions and status indicators, while keeping clicks and expansion available. It stops on approval waits or completion and respects reduced-motion preferences.
- Distinguish speech states by color: pulsing blue while generating, pulsing green while playing, red on failure, and the normal appearance after stopping.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/README.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/README.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
