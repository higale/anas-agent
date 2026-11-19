## Anas v5.2.18

- 修复历史附件重新编辑后“转为路径”误用副本的问题，保留原始 macOS、Windows 和网络共享路径。
- 图片限制校验提示支持中英文，覆盖添加、拖放、发送前及历史保留图片校验；附件异步读取期间切换语言后，提示使用当前语言，拒绝发送时保留草稿。
- 为配置了图片限制的模型显示彩色眼睛中心，并在模型选择和设置提示中展示准确的限制数值与大小计算口径；修复子图标提示被整行提示覆盖的问题。
- 统一工具功能图标为“扳手＋螺丝刀”。配置与数据库格式不变。

- Fix “Convert to path” for edited historical attachments to use the original macOS, Windows, or network-share path instead of an editing copy.
- Localize image-limit validation in English and Chinese when picking, dropping, or submitting attachments, including retained historical images. Pending attachment reads use the current UI language, and rejected submissions preserve the draft.
- Show a colored eye center for models with configured image limits and include exact limits and byte measurement basis in model-selection and settings tooltips. Keep icon-specific tooltips from being overwritten by the row tooltip.
- Unify tool-function icons with a wrench-and-screwdriver design. Configuration and database formats are unchanged.
