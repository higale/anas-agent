import json
import sys


def main():
    if len(sys.argv) != 2:
        raise ValueError("Expected one JSON object argument")
    data = json.loads(sys.argv[1])
    if not isinstance(data, dict) or set(data) != {"text"}:
        raise ValueError("Expected an object containing only text")
    text = data["text"]
    if not isinstance(text, str) or not 1 <= len(text) <= 8192:
        raise ValueError("text must be a string of 1 to 8192 Unicode code points")
    cleaned = text.strip()
    if not cleaned:
        raise ValueError("text must contain a non-whitespace character")
    print(json.dumps({"text": cleaned, "characters": len(cleaned)}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
