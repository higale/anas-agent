## Anas v3.3.16

- 模型选择菜单改为供应商与模型双栏布局，优化对齐、选中背景和双行摘要；展示上下文、输出限制及能力图标，选择框提供详细模型提示。
- 支持供应商自定义品牌图标，内置模板使用精简的 SVG；SVG 文件限制 1 MiB，支持的普通图片自动居中裁剪为正方形并缩小至不超过 512 像素，错误提示支持中英双语。空图标直接显示默认图标，点击删除时才按 API 地址恢复模板图标。
- 简化模型列表鉴权配置，根据实际请求地址识别 Anthropic 官方接口；其他地址使用 Bearer 鉴权。
- 优化共享多选控件的勾选样式，居中百炼登录操作，并保留百炼额度百分比的小数精度。
- 改进文件工具调用示例、补丁行号与格式修正提示，消除重复报错；修复扩展属性引起的 ctime 变化被误判为文件冲突，统一执行、回滚和撤销检查，继续保留内容哈希、文件身份、权限与修改时间校验。

- Redesign model selection with side-by-side provider and model lists, improved alignment and selection highlighting, and two-line context/output summaries with capability icons; show detailed model information on the selector tooltip.
- Add custom provider brand icons and optimized SVG icons in built-in templates. Limit SVG files to 1 MiB and automatically center-crop supported raster images to squares no larger than 512 pixels, with localized errors. Empty icons use the default immediately; deleting a custom icon restores a matching template icon by API URL.
- Simplify model-list authentication: recognize the official Anthropic endpoint from the actual request URL and use Bearer authentication for other hosts.
- Refine shared multiselect checkmarks, center Bailian sign-in actions, and preserve decimal precision in Bailian quota percentages.
- Improve file-tool examples, patch line diagnostics and correction guidance, and remove duplicate error wrapping. Avoid false file conflicts caused solely by extended-attribute ctime changes across execution, rollback and undo, while retaining content hashes, file identity, permissions and modification-time checks.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/README.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/README.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
