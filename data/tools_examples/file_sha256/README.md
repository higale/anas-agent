# File SHA-256

Requires Python 3.8 or later with no third-party packages. Set the command to the script path; Anas locates an available local Python 3 interpreter automatically. To use a specific interpreter or virtual environment, prefix the script path with its executable path.

Example arguments: `{"path":"/absolute/path/archive.zip"}`. Reads 1 MiB at a time and writes JSON containing the path, bytes read, and SHA-256 to stdout. Failures are written to stderr with a nonzero exit status.

Keep the file unchanged during verification. There is no timeout by default; adjust it in the tool editor if needed.
