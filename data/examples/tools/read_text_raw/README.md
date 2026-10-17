# Raw Text Reading

Requires Python 3 with no third-party packages. Set the command to the script path; Anas locates an available local Python 3 interpreter automatically. To use a specific interpreter or virtual environment, prefix the script path with its executable path.

Example arguments: `{"path":"/absolute/path/notes.txt"}`. Writes the UTF-8 file's raw bytes, preserving line endings and any BOM, without adding line numbers or a trailing newline.

The maximum file size is 512 KiB (524,288 bytes). Files within the limit are returned in full. Size, encoding, or read failures produce only an error on stderr, without partial content. Keep the interactive terminal (PTY) disabled to prevent it from rewriting line endings.
