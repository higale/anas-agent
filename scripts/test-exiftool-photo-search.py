"""Offline behavior checks: python3 -B scripts/test-exiftool-photo-search.py."""

from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "data/skills_examples/exiftool-photo-search/scripts/search.py"
spec = importlib.util.spec_from_file_location("photo_skill", SCRIPT)
skill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(skill)


class PhotoSearchTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name).resolve()
        self.subdir = self.root / "照片 subset"
        self.subdir.mkdir()
        self.photos = [
            self.subdir / "2026-09-28.png",
            self.root / "2026-09-27.png",
            self.root / "2026-09-26.png",
        ]
        for photo in self.photos:
            photo.touch()
        self.scanned = []

    def read_metadata(self, executable, files):
        self.scanned.extend(files)
        return [
            {
                "SourceFile": str(path),
                "XMP-dc:Subject": ["test-photo"],
                "ExifIFD:DateTimeOriginal": path.stem.replace("-", ":") + " 12:00:00",
            }
            for path in files
        ], ""

    def search(self, roots, options=()):
        arguments = [str(SCRIPT), "--query", "test-photo", "--batch-size", "1", *options]
        for root in roots:
            arguments.extend(["--root", str(root)])
        stdout = io.StringIO()
        with patch.object(skill.sys, "argv", arguments), \
             patch.object(skill.shutil, "which", return_value="exiftool"), \
             patch.object(skill, "run_exiftool", side_effect=self.read_metadata), \
             redirect_stdout(stdout):
            self.assertEqual(skill.main(), 0)
        return json.loads(stdout.getvalue())

    def test_overlapping_roots_and_individual_files_are_counted_once(self):
        result = self.search([self.root, self.subdir, self.root, self.photos[0]])
        self.assertEqual(result["candidate_count"], 3)
        self.assertEqual(result["scanned_count"], 3)
        self.assertEqual(result["match_count"], 3)
        self.assertEqual([Path(item["path"]) for item in result["matches"]], self.photos)
        self.assertCountEqual(self.scanned, self.photos)

    def test_scan_limit_is_applied_to_distinct_photos(self):
        result = self.search([self.root, self.subdir], ["--scan-limit", "2"])
        self.assertEqual(result["scanned_count"], 2)
        self.assertEqual(result["match_count"], 2)
        self.assertEqual([Path(item["path"]) for item in result["matches"]], self.photos[:2])
        self.assertCountEqual(self.scanned, self.photos[:2])

    def test_result_limit_is_not_consumed_by_duplicate_matches(self):
        result = self.search([self.root, self.photos[0]], ["--limit", "2"])
        self.assertEqual(result["match_count"], 3)
        self.assertEqual([Path(item["path"]) for item in result["matches"]], self.photos[:2])


if __name__ == "__main__":
    unittest.main()
