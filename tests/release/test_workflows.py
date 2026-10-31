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
        self.assertEqual(jobs["version"]["needs"], "release-tooling")
        self.assertIn("windows-smoke", jobs["release"]["needs"])
        self.assertNotIn("emulator-tests", jobs)

    def test_native_build_is_reused_by_all_isolated_suites(self):
        jobs = self.ci["jobs"]
        build = jobs["windows-native-build"]
        steps = build["steps"]
        runtime = next(i for i, step in enumerate(steps) if step.get("name") == "Ensure WebView2 Runtime")
        compile_at = next(i for i, step in enumerate(steps) if step.get("run") == "npm run verify -- --build-only")
        startup = next(i for i, step in enumerate(steps) if "scripts/ui-startup.mjs" in step.get("run", ""))
        self.assertLess(runtime, startup)
        self.assertLess(compile_at, startup)
        self.assertNotIn("cargo build", str(steps))
        smoke = jobs["windows-smoke"]
        self.assertEqual(smoke["needs"], "windows-native-build")
        self.assertEqual(smoke["strategy"]["fail-fast"], "false")
        self.assertEqual(set(smoke["strategy"]["matrix"]["suite"]), {"core", "workspace", "cleanup", "worktrees"})
        self.assertNotIn("npm run verify", str(smoke))
        self.assertIn("SHA-256 mismatch", str(smoke))
        self.assertIn("needs.windows-native-build.outputs.sha256", str(smoke))
        self.assertTrue(any(step.get("if") == "always()" and "upload-artifact@" in step.get("uses", "") for step in smoke["steps"]))
        for job in (build, smoke):
            self.assertLessEqual(int(job["timeout-minutes"]), 30)
            self.assertIn("github.workspace", job["env"]["REVQORA_TEST_TMP"])
        # Packages may build alongside native tests, but publishing requires both.
        self.assertEqual(jobs["version"]["needs"], "release-tooling")
        self.assertIn("windows-smoke", jobs["release"]["needs"])
        self.assertIn("verify-packages", jobs["release"]["needs"])

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

    def test_gui_automation_feature_is_not_enabled_for_production_packages(self):
        build = self.ci["jobs"]["windows-native-build"]["steps"]
        verify = next(step for step in build if step.get("run") == "npm run verify -- --build-only")
        self.assertEqual(verify["env"]["REVQORA_VERIFY_UI_AUTOMATION"], "1")
        smoke = self.ci["jobs"]["windows-smoke"]
        self.assertEqual(smoke["env"]["REVQORA_VERIFY_UI_AUTOMATION"], "1")
        for workflow in (self.ci, self.package):
            self.assertNotIn("REVQORA_VERIFY_UI_AUTOMATION", workflow.get("env", {}))
            for name, job in workflow["jobs"].items():
                if name not in {"windows-smoke", "windows-native-build", "build-and-test"}:
                    self.assertNotIn("ui-automation", str(job))
                    self.assertNotIn("REVQORA_VERIFY_UI_AUTOMATION", str(job))
                for step in job.get("steps", []):
                    self.assertFalse(step.get("uses", "").startswith("actions/cache@"))
                    if step.get("uses", "").startswith("actions/setup-node@"):
                        self.assertEqual(step["with"]["package-manager-cache"], "false")
                        self.assertNotIn("cache", step["with"])
        feature = next(step for step in self.ci["jobs"]["build-and-test"]["steps"] if step.get("name") == "Lint and test the Windows automation feature")
        self.assertEqual(feature["if"], "runner.os == 'Windows'")
        self.assertIn("cargo clippy", feature["run"])
        self.assertIn("--all-targets --features ui-automation -- -D warnings", feature["run"])
        self.assertIn("cargo test", feature["run"])
