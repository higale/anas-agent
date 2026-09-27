"""Offline behavior checks: python3 -B scripts/test-baidu-search-tool.py."""

from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.error


PACKAGE = Path(__file__).resolve().parents[1] / "data/tools_examples/baidu-search"
SCRIPT = PACKAGE / "scripts/run.py"
spec = importlib.util.spec_from_file_location("baidu_tool", SCRIPT)
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)
RESULT = {"request_id": "request-1", "references": [{"title": "Example", "url": "https://example.com/"}]}
TEST_KEY = "offline-test-key"


class BaiduSearchToolTests(unittest.TestCase):
    def invoke(self, arguments, *, key=TEST_KEY, result=RESULT, body=None, failure=None, argv=None):
        response = io.BytesIO(json.dumps(result).encode("utf-8") if body is None else body)
        response.status = 200
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.dict(tool.os.environ, {"BAIDU_SEARCH_API_KEY": key}), \
             patch.object(tool.sys, "argv", [str(SCRIPT), *(argv if argv is not None else [json.dumps(arguments)])]), \
             patch.object(tool.urllib.request, "urlopen", return_value=response, side_effect=failure) as send, \
             redirect_stdout(stdout), redirect_stderr(stderr):
            status = tool.main()
        output, error = stdout.getvalue(), stderr.getvalue()
        self.assertNotIn(TEST_KEY, output + error)
        return status, json.loads(output) if output else None, json.loads(error) if error else None, send

    def test_search_preserves_query_and_source_links(self):
        query = '上海 "天气" & $()'
        status, output, error, send = self.invoke({"query": "  " + query + "\n"})
        self.assertEqual(status, 0)
        self.assertIsNone(error)
        self.assertEqual(output, {"ok": True, "query": query, "status": 200, "data": RESULT})
        send.assert_called_once()
        request = send.call_args.args[0]
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.full_url, "https://qianfan.baidubce.com/v2/ai_search/web_search")
        self.assertEqual(request.get_header("Authorization"), "Bearer " + TEST_KEY)
        self.assertEqual(json.loads(request.data), {
            "messages": [{"role": "user", "content": query}], "search_source": "baidu_search_v2",
        })
        self.assertEqual(send.call_args.kwargs["timeout"], 30)

    def test_custom_timeout_is_forwarded(self):
        status, _, _, send = self.invoke({"query": "test", "timeout": 120})
        self.assertEqual(status, 0)
        self.assertEqual(send.call_args.kwargs["timeout"], 120)

    def test_query_limit_uses_encoded_bytes(self):
        for query in ["a" * 72, "中" * 36, "🙂" * 18]:
            with self.subTest(query=query):
                status, _, _, send = self.invoke({"query": query})
                self.assertEqual(status, 0)
                send.assert_called_once()
        for query in ["a" * 73, "中" * 37, "🙂" * 19]:
            with self.subTest(query=query):
                status, output, error, send = self.invoke({"query": query})
                self.assertEqual(status, 2)
                self.assertIsNone(output)
                self.assertIn("72", error["error"])
                send.assert_not_called()

    def test_invalid_arguments_do_not_submit(self):
        cases = [
            [], None, {}, {"query": 1}, {"query": " \n\t"}, {"query": "\ud800"},
            {"query": "test", "unexpected": 1},
            *[{"query": "test", "timeout": value} for value in [True, False, 0, -1, 121, 1.5, "30", None]],
        ]
        for arguments in cases:
            with self.subTest(arguments=arguments):
                status, output, error, send = self.invoke(arguments)
                self.assertEqual(status, 2)
                self.assertIsNone(output)
                self.assertFalse(error["ok"])
                send.assert_not_called()

    def test_malformed_json_and_argument_count_are_reported(self):
        for argv in [[], ["{"], ["{}", "{}"]]:
            with self.subTest(argv=argv):
                status, output, error, send = self.invoke(None, argv=argv)
                self.assertEqual(status, 2)
                self.assertIsNone(output)
                self.assertFalse(error["ok"])
                send.assert_not_called()

    def test_missing_credentials_do_not_submit(self):
        status, output, error, send = self.invoke({"query": "test"}, key="  ")
        self.assertEqual(status, 2)
        self.assertIsNone(output)
        self.assertIn("BAIDU_SEARCH_API_KEY", error["error"])
        send.assert_not_called()

    def test_service_error_is_not_reported_as_success(self):
        status, output, error, send = self.invoke({"query": "test"}, result={
            "code": "InvalidParameter", "message": "Invalid query", "request_id": "request-2",
        })
        self.assertEqual(status, 1)
        self.assertIsNone(output)
        self.assertEqual(error["code"], "InvalidParameter")
        self.assertEqual(error["request_id"], "request-2")
        send.assert_called_once()

    def test_http_failure_is_reported_without_retry(self):
        failure = urllib.error.HTTPError("https://example.com", 429, "Busy", {}, io.BytesIO(b'{"message":"Busy"}'))
        status, output, error, send = self.invoke({"query": "test"}, failure=failure)
        self.assertEqual(status, 1)
        self.assertIsNone(output)
        self.assertEqual(error["status"], 429)
        self.assertEqual(error["data"], {"message": "Busy"})
        send.assert_called_once()

    def test_network_failures_are_reported_without_retry(self):
        for failure in [TimeoutError(), urllib.error.URLError(TimeoutError()), urllib.error.URLError("offline")]:
            with self.subTest(failure=failure):
                status, output, error, send = self.invoke({"query": "test"}, failure=failure)
                self.assertEqual(status, 1)
                self.assertIsNone(output)
                self.assertFalse(error["ok"])
                send.assert_called_once()

    def test_invalid_server_responses_are_not_success(self):
        for body in [b"not JSON", b"[]"]:
            with self.subTest(body=body):
                status, output, error, send = self.invoke({"query": "test"}, body=body)
                self.assertEqual(status, 1)
                self.assertIsNone(output)
                self.assertFalse(error["ok"])
                send.assert_called_once()

    def test_host_deadline_allows_the_longest_network_timeout(self):
        manifest = json.loads((PACKAGE / "TOOL.json").read_text(encoding="utf-8"))
        self.assertGreater(manifest["timeout_seconds"], manifest["input_schema"]["properties"]["timeout"]["maximum"])


if __name__ == "__main__":
    unittest.main()
