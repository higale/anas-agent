## Anas v3.2.0

- 技能和工具文件支持语法高亮、Markdown 预览及非系统文件编辑；保存时检查外部修改冲突，并保留脚本权限。
- 自定义工具支持在用户及外加目录中新增、导入、编辑和删除；支持可视化编辑参数、定位入口脚本，以及创建缺失的脚本文件。
- 字体大小和朗读语速使用带刻度、滑块内显示当前值的紧凑控件；字号范围调整为 10–18，默认 14。
- 统一分段选择和控件高度，精简模型编辑布局，推理选项采用左侧列表、右侧参数的布局，固定弹窗区域使用分隔线区分。
- 数值设置支持千位分隔、直接输入和增减操作，保留原有单位、范围及不限量选项。
- stdio MCP 工作目录留空时使用用户主目录，并在输入框显示明确提示；修正 Windows 下脚本父路径不是目录时的判断。

- Add syntax highlighting, Markdown previews, and editing for non-system skill and tool files, with external-change conflict checks and preserved script permissions.
- Create, import, edit, and delete custom tools in user and added directories. Edit parameters visually, locate entry scripts, and create missing script files.
- Use compact sliders with tick marks and values inside the handles for font size and speech speed. Font sizes now range from 10 to 18, with 14 as the default.
- Unify segmented controls and control heights, simplify the model editor, arrange reasoning options as a list beside the parameter editor, and separate fixed dialog areas with dividers.
- Add thousands separators, direct entry, and step controls to numeric settings while preserving their units, ranges, and unlimited options.
- Default blank stdio MCP working directories to the user's home directory with a clear placeholder. Correct script-path checks on Windows when a parent is a file rather than a directory.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/README.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/README.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
