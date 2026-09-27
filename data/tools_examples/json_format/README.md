# JSON Formatting

Requires Python 3 with no third-party packages. Set the command to the script path; Anas locates an available local Python 3 interpreter automatically. To use a specific interpreter or virtual environment, prefix the script path with its executable path.

Example arguments: `{"value":{"b":2,"a":"hello"},"sort_keys":true}`. Writes JSON with two-space indentation to stdout without a trailing newline. It does not read or write files.

If the formatted output exceeds 100000 UTF-8 bytes, the tool reports an error instead of truncating it.
