from pathlib import Path
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
BASH = str(Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe") if os.name == "nt" else "bash"


class FixtureSafetyTests(unittest.TestCase):
    def run_generator(self, script, target):
        command = [BASH, (ROOT / "scripts/make-demo-repo.sh").as_posix(), target.as_posix()] if script == "demo" else [sys.executable, "-B", str(ROOT / "scripts/make-big-repo.py"), str(target), "8", "2"]
        env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
        return subprocess.run(command, capture_output=True, env=env, timeout=60)

    def test_generators_refuse_existing_work_without_touching_it(self):
        for script in ("demo", "large"):
            with self.subTest(script=script), tempfile.TemporaryDirectory() as temporary:
                target = Path(temporary) / "existing work"
                target.mkdir()
                sentinel = target / "README.md"
                sentinel.write_text("irreplaceable project data", encoding="utf-8")
                result = self.run_generator(script, target)
                self.assertNotEqual(result.returncode, 0, result.stdout.decode(errors="replace"))
                self.assertEqual(sentinel.read_text(encoding="utf-8"), "irreplaceable project data")
                self.assertEqual(list(target.iterdir()), [sentinel])

    def test_generators_still_build_real_repositories_in_new_directories(self):
        for script in ("demo", "large"):
            with self.subTest(script=script), tempfile.TemporaryDirectory() as temporary:
                target = Path(temporary) / "new fixtures"
                result = self.run_generator(script, target)
                self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
                repo = target / "demo" if script == "demo" else target
                count = subprocess.check_output(["git", "-C", str(repo), "rev-list", "--count", "--all"], text=True)
                self.assertGreater(int(count), 0)
                status = subprocess.check_output(["git", "-C", str(repo), "status", "--porcelain", "--untracked-files=all"], text=True)
                expected = " M src/app.ts\n M src/config.json\n?? docs/notes.md\n" if script == "demo" else ""
                self.assertEqual(status, expected)
