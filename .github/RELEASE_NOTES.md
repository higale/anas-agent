## Anas v3.1.5

- 改进会话数据修复，保留文件修改历史和撤销关联，解决部分会话修复后仍无法打开或删除的问题。
- 修复元数据时保留已删除轮次的历史引用，避免无关引用阻断会话恢复。
- 开发构建和本地打包正确显示构建时间，有时间信息时不再重复显示 Development 标识。

- Improve conversation data repair while preserving file change history and undo references, fixing cases where repaired conversations could not be opened or deleted.
- Preserve historical references to deleted rounds during metadata repair so they no longer block conversation recovery.
- Show build timestamps in development builds and local packages, without a redundant Development label when a timestamp is available.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/README.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/README.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
