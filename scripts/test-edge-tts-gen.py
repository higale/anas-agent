"""Offline behavior checks: python3 -B scripts/test-edge-tts-gen.py."""

import asyncio
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "data/skills_examples/edge-tts-gen/scripts/generate.py"
spec = importlib.util.spec_from_file_location("edge_skill", SCRIPT)
skill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(skill)

# Exercise the CLI's argparse interface without making a speech request.
OFFLINE_CLI = """import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--text', required=True)
parser.add_argument('--voice', required=True)
parser.add_argument('--write-media', required=True)
parser.add_argument('--rate', default='+0%')
parser.add_argument('--volume', default='+0%')
parser.add_argument('--pitch', default='+0Hz')
args = parser.parse_args()
Path(args.write_media).write_text(json.dumps(vars(args), ensure_ascii=False), encoding='utf-8')
"""


class EdgeSkillTests(unittest.TestCase):
    def invoke_cli(self, options, expected):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            cli = root / "offline cli.py"
            cli.write_text(OFFLINE_CLI, encoding="utf-8")
            output = root / "语音 output.mp3"
            text = '你好，"测试"。\nSecond line.'
            args = skill.parser().parse_args([
                "--text", text, "--output", str(output), *options,
            ])
            stdout, stderr = io.StringIO(), io.StringIO()
            with patch.object(skill, "generate_with_module", side_effect=ImportError("module unavailable")), \
                 patch.object(skill, "command_executors", return_value=[[sys.executable, "-B", str(cli)]]), \
                 redirect_stdout(stdout), redirect_stderr(stderr):
                status = asyncio.run(skill.generate(args))
            self.assertEqual(status, 0, stderr.getvalue())
            result = json.loads(stdout.getvalue())
            self.assertTrue(result["ok"])
            self.assertEqual(Path(result["output"]), output)
            self.assertEqual(result["bytes"], output.stat().st_size)
            received = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(received["text"], text)
            for key, value in expected.items():
                self.assertEqual(received[key], value)

    def test_cli_accepts_negative_rate_volume_and_pitch(self):
        options = {"rate": "-10%", "volume": "-5%", "pitch": "-10Hz"}
        for key, value in options.items():
            with self.subTest(option=key):
                self.invoke_cli([f"--{key}={value}"], {key: value})
        self.invoke_cli([f"--{key}={value}" for key, value in options.items()], options)

    def test_cli_preserves_default_and_positive_values(self):
        self.invoke_cli([], {"rate": "+0%", "volume": "+0%", "pitch": "+0Hz"})
        options = {"rate": "+10%", "volume": "+5%", "pitch": "+10Hz"}
        self.invoke_cli([f"--{key}={value}" for key, value in options.items()], options)


if __name__ == "__main__":
    unittest.main()
