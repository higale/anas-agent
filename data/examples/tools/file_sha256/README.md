# File SHA-256

工具示例：在“设置 → 工具”选中用户或外加目录分组，点击“导入工具”选择本目录，再在能力设置中启用。导入后的配置和脚本可以自由修改，不随示例更新覆盖。

Tool example: in Settings → Tools, select the User group or an added directory and use Import tools to import this folder. Then enable it in capability settings. The imported configuration and script are editable and will not be overwritten by example updates.

需要 Python 3.8 或更高版本，无第三方依赖。参数示例：`{"path":"/absolute/path/archive.zip"}`。按 1 MiB 分块读取，向 stdout 输出路径、读取字节数和 SHA-256 的 JSON；失败时向 stderr 输出错误并以非零状态退出。校验期间请勿修改文件。默认不限时，可在工具编辑器中设置超时。

Requires Python 3.8 or later with no third-party packages. Set the command to the script path; Anas locates an available local Python 3 interpreter automatically. To use a specific interpreter or virtual environment, prefix the script path with its executable path.

Example arguments: `{"path":"/absolute/path/archive.zip"}`. Reads 1 MiB at a time and writes JSON containing the path, bytes read, and SHA-256 to stdout. Failures are written to stderr with a nonzero exit status.

Keep the file unchanged during verification. There is no timeout by default; adjust it in the tool editor if needed.
