# JSON Formatting

系统工具：在能力设置中选中即可使用。需要修改配置或脚本时，将工具包导入为用户副本后编辑。

System tool: select it in capability settings to use it. Import a user copy before customizing its configuration or script.

Requires Python 3 with no third-party packages. Set the command to the script path; Anas locates an available local Python 3 interpreter automatically. To use a specific interpreter or virtual environment, prefix the script path with its executable path.

Example arguments: `{"value":{"b":2,"a":"hello"},"sort_keys":true}`. Writes JSON with two-space indentation to stdout without a trailing newline. It does not read or write files.

If the formatted output exceeds 100000 UTF-8 bytes, the tool reports an error instead of truncating it.
