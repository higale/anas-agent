# JSON Formatting

工具示例：在“设置 → 工具”选中用户或外加目录分组，点击“导入工具”选择本目录，再在能力设置中启用。导入后的配置和脚本可以自由修改，不随示例更新覆盖。

Tool example: in Settings → Tools, select the User group or an added directory and use Import tools to import this folder. Then enable it in capability settings. The imported configuration and script are editable and will not be overwritten by example updates.

需要 Python 3，无第三方依赖。参数示例：`{"value":{"b":2,"a":"hello"},"sort_keys":true}`。向 stdout 输出两空格缩进的 JSON，末尾不追加换行，不读写文件。输出超过 100000 字节（UTF-8）时返回错误，不截断内容。

Requires Python 3 with no third-party packages. Set the command to the script path; Anas locates an available local Python 3 interpreter automatically. To use a specific interpreter or virtual environment, prefix the script path with its executable path.

Example arguments: `{"value":{"b":2,"a":"hello"},"sort_keys":true}`. Writes JSON with two-space indentation to stdout without a trailing newline. It does not read or write files.

If the formatted output exceeds 100000 UTF-8 bytes, the tool reports an error instead of truncating it.
