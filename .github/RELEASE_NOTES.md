## Anas v5.0.8

- 工具调用展开时统一加载参数和返回值，收起后释放详情；内部参数与结果的展开切换复用已加载数据。
- 恢复返回值标题旁的图片预览入口，加载工具调用详情后即可预览图片，无需展开结果正文。
- 加宽项目设置弹窗，并限制左栏最大宽度，让宽窗口为右侧能力区提供更多空间。
- 文件读、文件写和记忆收起时紧凑并排，展开时占满一行；统一展开图标与复选框间距，展开后同时显示数量和收起入口。
- 自定义工具显示启用数量与总数，补充 MCP 分区标题，并加宽插件工具列表项，减少长工具名换行。

**从 5.0.2～5.0.7 升级无需重置项目或会话。**

- Expanding a tool call loads its arguments and result together; collapsing it releases the details. Inner argument and result toggles reuse the loaded data.
- Restore image previews beside the result heading. Once the tool call details load, images can be previewed without expanding the result body.
- Widen project settings and cap the left pane width, giving the capabilities pane more room in wide windows.
- File read, file write and memory groups share rows when collapsed and span the full row when expanded. Disclosure icons and checkbox spacing are consistent, with both counts and collapse controls shown while expanded.
- Show enabled and total custom tool counts, add the MCP section heading, and widen plugin tool items to reduce wrapping of long names.

**Upgrading from 5.0.2–5.0.7 does not require resetting projects or conversations.**

## 较早版本升级 / Upgrading from earlier versions

- 从 5.0.1 或更早版本跨越 5.0.2 升级，需要重置全部项目与会话。5.0 不支持导入旧版对话、记忆、运行记录或整包备份；兼容配置与扩展资源的手动复制方式见 [5.0 升级说明](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_5.zh-CN.md)。
- 从 4.0 之前的版本跨入 4.x 时，历史数据目录有变化，见 [4.x 升级说明](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.zh-CN.md)；其中的数据库恢复方法不适用于 5.0。

- Upgrading from 5.0.1 or earlier across the 5.0.2 boundary requires resetting all projects and conversations. Version 5.0 cannot import older conversations, memories, run history or full backups. See the [5.0 upgrade guide](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_5.en.md) for manually copying compatible settings and extensions.
- Moving from a version before 4.0 into 4.x also involves historical data folder changes. See the [4.x upgrade guide](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.en.md); its database recovery instructions do not apply to 5.0.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.zh-CN.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/data/help/USER_GUIDE.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
