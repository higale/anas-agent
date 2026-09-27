#!/usr/bin/env python3
"""Baidu AI Search custom tool for Anas.

Receives a single JSON argument with "query" (required) and optional "timeout".
Returns search results on stdout as JSON; diagnostics on stderr.
Exits nonzero on failure.
"""
import json
import os
import socket
import sys
import urllib.error
import urllib.request

ENDPOINT = "https://qianfan.baidubce.com/v2/ai_search/web_search"
API_KEY_ENV = "BAIDU_SEARCH_API_KEY"
DEFAULT_TIMEOUT = 30
MAX_TIMEOUT = 120
MAX_QUERY_GB18030_LEN = 72


def configure_stdio():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def print_json(data):
    print(json.dumps(data, ensure_ascii=False, indent=2))


def print_error(data):
    print(json.dumps(data, ensure_ascii=False, indent=2), file=sys.stderr)


def query_length(value):
    """Return the GB18030 byte length, including four-byte characters."""
    return len(value.encode("gb18030"))


def request_search(query, api_key, timeout):
    payload = json.dumps({
        "messages": [
            {
                "role": "user",
                "content": query,
            }
        ],
        "search_source": "baidu_search_v2",
    }).encode("utf-8")
    request = urllib.request.Request(
        ENDPOINT,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(body)
        except json.JSONDecodeError as error:
            raise RuntimeError("Baidu AI Search returned invalid JSON.") from error
        if not isinstance(data, dict):
            raise RuntimeError("Baidu AI Search returned a non-object JSON response.")
        return response.status, data


def parse_tool_args():
    """Parse the single JSON argument passed by Anas."""
    if len(sys.argv) != 2:
        raise ValueError("Expected exactly one JSON object argument.")
    try:
        data = json.loads(sys.argv[1])
    except json.JSONDecodeError as error:
        raise ValueError(f"Invalid JSON argument: {error}") from error
    if not isinstance(data, dict):
        raise ValueError("Argument must be a JSON object.")

    # Validate query
    if "query" not in data:
        raise ValueError("Missing required field: query.")
    query = data["query"]
    if not isinstance(query, str):
        raise ValueError("query must be a string.")
    query = query.strip()
    if not query:
        raise ValueError("query must not be empty.")

    # Validate timeout
    timeout = data.get("timeout", DEFAULT_TIMEOUT)
    if type(timeout) is not int or not 1 <= timeout <= MAX_TIMEOUT:
        raise ValueError(f"timeout must be an integer from 1 through {MAX_TIMEOUT}.")

    # Reject unknown fields
    allowed = {"query", "timeout"}
    extra = set(data) - allowed
    if extra:
        raise ValueError(f"Unknown fields: {', '.join(sorted(extra))}.")

    return query, timeout


def main():
    configure_stdio()

    try:
        query, timeout = parse_tool_args()
        query_bytes = query_length(query)
    except UnicodeEncodeError:
        print_error({"ok": False, "error": "query must contain valid Unicode text."})
        return 2
    except ValueError as error:
        print_error({"ok": False, "error": str(error)})
        return 2

    # Check query length limit
    if query_bytes > MAX_QUERY_GB18030_LEN:
        print_error({
            "ok": False,
            "error": "Query exceeds the 72-byte GB18030 limit (common Chinese characters usually use two bytes).",
            "next_step": "Shorten the query while preserving its key name, date, location, and constraints.",
        })
        return 2

    # Check API key
    api_key = os.environ.get(API_KEY_ENV, "").strip()
    if not api_key:
        print_error({
            "ok": False,
            "error": f"Missing environment variable: {API_KEY_ENV}.",
            "next_step": f"Configure {API_KEY_ENV} for this tool.",
        })
        return 2

    # Perform search
    try:
        status, data = request_search(query, api_key, timeout)
        error_code = data.get("code")
        if error_code not in (None, "", 0, "0"):
            print_error({
                "ok": False,
                "query": query,
                "status": status,
                "code": error_code,
                "error": str(data.get("message") or "Baidu AI Search returned an error."),
                **({"request_id": data["request_id"]} if data.get("request_id") else {}),
            })
            return 1
        print_json({
            "ok": True,
            "query": query,
            "status": status,
            "data": data,
        })
        return 0
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            resp_data = json.loads(body)
        except json.JSONDecodeError:
            resp_data = body
        print_error({
            "ok": False,
            "query": query,
            "status": exc.code,
            "error": str(exc.reason),
            "data": resp_data,
        })
        return 1
    except urllib.error.URLError as exc:
        timed_out = isinstance(exc.reason, (TimeoutError, socket.timeout))
        print_error({
            "ok": False,
            "query": query,
            "error": "Request timed out." if timed_out else str(exc.reason),
            "error_type": "TimeoutError" if timed_out else type(exc.reason).__name__,
        })
        return 1
    except TimeoutError:
        print_error({
            "ok": False,
            "query": query,
            "error": "Request timed out.",
            "error_type": "TimeoutError",
        })
        return 1
    except Exception as exc:
        print_error({
            "ok": False,
            "query": query,
            "error": str(exc),
            "error_type": type(exc).__name__,
        })
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
