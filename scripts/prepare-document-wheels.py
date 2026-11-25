"""Build-host only. Install pinned platform wheels without executing their code."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / "build/document-wheels.json").read_text())
CACHE = ROOT / "tmp/python-downloads/wheels"


def fetch(name):
    spec = LOCK["wheels"][name]
    path = CACHE / name
    if path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == spec["sha256"]:
        return path
    with tempfile.NamedTemporaryFile(dir=CACHE, delete=False) as output:
        partial = Path(output.name)
    try:
        subprocess.run(["curl.exe" if os.name == "nt" else "curl", "--fail", "--location", "--silent",
                        "--show-error", "--retry", "2", "--connect-timeout", "20", "--max-time", "150",
                        "--output", str(partial), spec["url"]], check=True)
        if hashlib.sha256(partial.read_bytes()).hexdigest() != spec["sha256"]:
            raise ValueError(f"Wheel checksum mismatch: {name}")
        os.replace(partial, path)
        return path
    finally:
        partial.unlink(missing_ok=True)


def install(wheel, directory):
    # Only these upstream format modules are used. Importing MarkItDown's full
    # registry also loads the ONNX file classifier, web and plugin machinery.
    core = {"_stream_info.py", "_base_converter.py", "_exceptions.py"}
    converters = {"_docx_converter.py", "_html_converter.py", "_markdownify.py",
                  "_pdf_converter.py", "_pptx_converter.py", "_llm_caption.py"}
    with zipfile.ZipFile(wheel) as archive:
        for entry in archive.infolist():
            if entry.is_dir():
                continue
            parts = entry.filename.split("/")
            if any(part in {"", ".", ".."} or ":" in part or "\\" in part for part in parts):
                raise ValueError(f"Unexpected path in {wheel.name}: {entry.filename}")
            if parts[0] == "markitdown":
                if not (len(parts) == 2 and parts[1] in core
                        or parts[1] == "converters" and parts[-1] in converters
                        or parts[1:3] == ["converter_utils", "docx"]
                        or parts[1:] == ["converter_utils", "_image.py"]):
                    continue
                parts[0] = "anas_markitdown"
            if parts[0].endswith(".data"):
                if parts[1] not in {"platlib", "purelib"}:
                    continue
                parts = parts[2:]
            target = directory.joinpath(*parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(entry) as source, target.open("wb") as dest:
                shutil.copyfileobj(source, dest)


def main():
    target, directory = sys.argv[1], Path(sys.argv[2])
    directory.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)
    wheels = LOCK["targets"][target]
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for wheel in pool.map(fetch, wheels):
            install(wheel, directory)


if __name__ == "__main__":
    main()
