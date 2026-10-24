from pathlib import Path
import re
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.ci = yaml.load((ROOT / ".github/workflows/ci.yml").read_text(), Loader=yaml.BaseLoader)
        self.package = yaml.load((ROOT / ".github/workflows/package.yml").read_text(), Loader=yaml.BaseLoader)

    def test_only_main_publisher_can_write(self):
        for workflow in (self.ci, self.package):
            self.assertEqual(workflow["permissions"], {"contents": "read"})
            self.assertNotIn("pull_request_target", workflow["on"])
            for name, job in workflow["jobs"].items():
                if name != "release":
                    self.assertNotIn("permissions", job)
        publisher = self.ci["jobs"]["release"]
        self.assertEqual(publisher["permissions"], {"contents": "write"})
        for context in ("bitcodepro/Revqora", "refs/heads/main", "'push'", "'workflow_dispatch'"):
            self.assertIn(context, publisher["if"])
        self.assertEqual(set(publisher["needs"]), {"release-tooling", "build-and-test", "windows-smoke", "version", "packages", "verify-packages"})

    def test_all_platforms_and_checks_are_present(self):
        jobs = self.ci["jobs"]
        self.assertEqual(len(jobs["build-and-test"]["strategy"]["matrix"]["os"]), 3)
        matrix = self.package["jobs"]["package"]["strategy"]["matrix"]["include"]
        self.assertEqual({row["rid"] for row in matrix}, {"win-x64", "linux-x64", "linux-arm64", "osx-arm64", "osx-x64"})
        self.assertIn("windows-smoke", jobs["version"]["needs"])
        self.assertNotIn("emulator-tests", jobs)

    def test_windows_smoke_requires_webview_runtime_before_verification(self):
        steps = self.ci["jobs"]["windows-smoke"]["steps"]
        runtime = next(i for i, step in enumerate(steps) if step.get("name") == "Ensure WebView2 Runtime")
        startup = next(i for i, step in enumerate(steps) if step.get("name") == "Verify native UI startup before release compilation")
        verify = next(i for i, step in enumerate(steps) if step.get("run") == "npm run verify")
        self.assertLess(runtime, startup)
        self.assertLess(startup, verify)
        self.assertIn("https://go.microsoft.com/fwlink/p/?LinkId=2124703", steps[runtime]["run"])
        self.assertIn("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", steps[runtime]["run"])

    def test_actions_are_pinned_and_checkouts_do_not_persist_credentials(self):
        for workflow in (self.ci, self.package):
            for job in workflow["jobs"].values():
                if "uses" not in job:
                    self.assertIn("timeout-minutes", job)
                for step in job.get("steps", []):
                    if "uses" in step:
                        self.assertRegex(step["uses"], r"^[\w/-]+@[0-9a-f]{40}$")
                        if step["uses"].startswith("actions/checkout@"):
                            self.assertEqual(step["with"]["persist-credentials"], "false")
                            self.assertEqual(step["with"]["ref"], "${{ github.sha }}")
