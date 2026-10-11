# 系统工具包 / System tool packages

此目录存放随应用分发的 `TOOL.json` 工具包，启动时同步到数据目录的 `tools_system/`。预置 `file_sha256`（文件 SHA-256）和 `json_format`（JSON 格式化），均使用 Python 3 标准库；无需导入；自定义工具能力选“全部”或在“定制”中选中后即可使用。

This directory holds bundled `TOOL.json` packages mirrored to `tools_system/` at startup. It includes `file_sha256` (file SHA-256) and `json_format` (JSON formatting), both using the Python 3 standard library. No import is required. Use All under custom-tool capabilities, or select them in Custom mode.
