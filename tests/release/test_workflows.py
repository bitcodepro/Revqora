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
        self.assertEqual(set(publisher["needs"]), {"release-tooling", "build-and-test", "windows-automation", "windows-smoke", "version", "packages", "verify-packages"})

    def test_all_platforms_and_checks_are_present(self):
        jobs = self.ci["jobs"]
        self.assertEqual(len(jobs["build-and-test"]["strategy"]["matrix"]["os"]), 3)
        matrix = self.package["jobs"]["package"]["strategy"]["matrix"]["include"]
        self.assertEqual({row["rid"] for row in matrix}, {"win-x64", "linux-x64", "linux-arm64", "osx-arm64", "osx-x64"})
        self.assertEqual(jobs["version"]["needs"], "release-tooling")
        self.assertIn("windows-smoke", jobs["release"]["needs"])
        self.assertNotIn("emulator-tests", jobs)
        checks = jobs["build-and-test"]
        for key in ("TEMP", "TMP", "TMPDIR"):
            self.assertEqual(checks["env"][key], checks["env"]["REVQORA_TEST_TMP"])
        self.assertIn("github.workspace", checks["env"]["REVQORA_TEST_TMP"])
        prepare = next(i for i, step in enumerate(checks["steps"]) if step.get("name") == "Prepare isolated temporary directory")
        verify = next(i for i, step in enumerate(checks["steps"]) if step.get("run") == "npm run verify:quick")
        self.assertLess(prepare, verify)
        cli = next(i for i, step in enumerate(checks["steps"]) if step.get("name") == "Verify cold Windows CLI dependency")
        self.assertEqual(checks["steps"][cli]["if"], "runner.os == 'Windows'")
        self.assertLess(prepare, cli)
        self.assertLess(cli, verify)

    def test_mac_arm_checks_and_package_share_a_non_cancelling_resource_queue(self):
        checks = self.ci["jobs"]["build-and-test"]["concurrency"]
        packages = self.package["jobs"]["package"]["concurrency"]
        for gate in (checks, packages):
            self.assertIn("format('macos-arm-{0}', github.repository)", gate["group"])
            self.assertEqual(gate["cancel-in-progress"], "false")
            self.assertEqual(gate["queue"], "max")
            self.assertIn("github.run_id", gate["group"])
            self.assertIn("github.run_attempt", gate["group"])
        self.assertIn("matrix.os == 'macos-15'", checks["group"])
        self.assertIn("matrix.rid == 'osx-arm64'", packages["group"])

    def test_native_build_is_reused_by_all_isolated_suites(self):
        jobs = self.ci["jobs"]
        build = jobs["windows-native-build"]
        steps = build["steps"]
        runtime = next(i for i, step in enumerate(steps) if step.get("name") == "Ensure WebView2 Runtime")
        compile_at = next(i for i, step in enumerate(steps) if step.get("run") == "npm run verify -- --build-only")
        startup = next(i for i, step in enumerate(steps) if "scripts/ui-startup.mjs" in step.get("run", ""))
        self.assertLess(runtime, startup)
        self.assertLess(compile_at, startup)
        # Retain the exact binary even when startup fails, while the failed build
        # job still blocks every native suite through its existing needs edge.
        upload = next(i for i, step in enumerate(steps) if step.get("with", {}).get("name") == "windows-native-smoke-build")
        self.assertLess(compile_at, upload)
        self.assertLess(upload, startup)
        self.assertNotIn("continue-on-error", steps[startup])
        self.assertIn("ci-results/startup", steps[startup]["env"]["REVQORA_SMOKE_OUT"])
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
            self.assertEqual(job["env"]["WEBVIEW2_BROWSER_EXECUTABLE_FOLDER"], "")
            self.assertNotIn("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER=$runtime", str(job))
            runtime = next(step for step in job["steps"] if step.get("name") == "Ensure WebView2 Runtime")
            self.assertEqual(runtime["run"], "./scripts/ensure-webview-runtime.ps1")
            self.assertNotIn("if", runtime)
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
                    if "uses" in step and step["uses"].startswith("./"):
                        self.assertEqual(step["uses"], "./.github/actions/dependency-cache")
                        continue
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
                if name not in {"windows-smoke", "windows-native-build", "windows-automation"}:
                    self.assertNotIn("ui-automation", str(job))
                    self.assertNotIn("REVQORA_VERIFY_UI_AUTOMATION", str(job))
                for step in job.get("steps", []):
                    self.assertFalse(step.get("uses", "").startswith("actions/cache@"))
                    if step.get("uses", "").startswith("actions/setup-node@"):
                        self.assertEqual(step["with"]["package-manager-cache"], "false")
                        self.assertNotIn("cache", step["with"])

    def test_both_complete_windows_configurations_and_diagnostics_gate_release_in_parallel(self):
        jobs = self.ci["jobs"]
        normal, automation = jobs["build-and-test"], jobs["windows-automation"]
        self.assertNotIn("ui-automation", str(normal))
        self.assertTrue(any(s.get("run") == "npm run verify:quick" for s in normal["steps"]))
        self.assertEqual(automation["runs-on"], "windows-2025")
        for job in (normal, automation):
            self.assertLessEqual(int(job["timeout-minutes"]), 35)
            self.assertNotIn("if", job)
            self.assertNotIn("continue-on-error", job)
            self.assertNotIn("build-and-test", job.get("needs", []))
            self.assertNotIn("windows-automation", job.get("needs", []))
            for key in ("TEMP", "TMP", "TMPDIR"):
                self.assertEqual(job["env"][key], job["env"]["REVQORA_TEST_TMP"])
            for step in job["steps"]:
                self.assertNotIn("continue-on-error", step)
        commands = [s for s in automation["steps"] if s.get("run", "").lstrip().startswith("cargo ")]
        self.assertEqual(len(commands), 2)
        self.assertEqual(commands[0]["run"].strip(), "cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features ui-automation -- -D warnings\nexit $LASTEXITCODE")
        self.assertEqual(commands[1]["run"].strip(), "cargo test --manifest-path src-tauri/Cargo.toml --features ui-automation\nexit $LASTEXITCODE")
        for command in commands:
            self.assertNotIn("if", command)  # Both remain full, unconditional checks.
        readiness = next(i for i, s in enumerate(automation["steps"]) if s.get("name") == "Verify cold Windows CLI dependency")
        tests = next(i for i, s in enumerate(automation["steps"]) if s.get("name") == "Test the complete Windows automation configuration")
        self.assertEqual(automation["steps"][readiness]["run"], "node scripts/windows-cli-readiness.mjs")
        self.assertNotIn("if", automation["steps"][readiness])
        self.assertLess(readiness, tests)
        self.assertEqual(automation["env"]["REVQORA_AGENT_TEST_DIAGNOSTICS"], "${{ github.workspace }}/ci-results/agent-test-failures")
        diagnostic = next(s for s in automation["steps"] if "agent-windows-diagnostics.mjs" in s.get("run", ""))
        self.assertEqual(diagnostic["if"], "runner.os == 'Windows' && !cancelled()")
        self.assertEqual(diagnostic["run"], "node scripts/agent-windows-diagnostics.mjs --out ci-results/agent-windows-diagnostics")
        self.assertIn("windows-automation", jobs["release"]["needs"])
        self.assertTrue(any(s.get("with", {}).get("name") == "windows-agent-diagnostics" for s in automation["steps"]))
        evidence = next(s["with"]["path"] for s in automation["steps"] if s.get("with", {}).get("name") == "windows-agent-diagnostics")
        for path in ("ci-results/agent-windows-diagnostics", "ci-results/agent-test-failures", "ci-results/windows-cli-readiness.json"):
            self.assertIn(path, evidence.splitlines())

    def test_quick_stage_timings_survive_failure_for_each_platform(self):
        checks = self.ci["jobs"]["build-and-test"]
        self.assertIn("github.workspace", checks["env"]["REVQORA_VERIFY_TIMINGS"])
        upload = next(s for s in checks["steps"] if s.get("with", {}).get("name") == "quick-verification-${{ matrix.os }}")
        self.assertEqual(upload["if"], "always()")
        self.assertEqual(upload["with"]["path"], "ci-results/verify-stages.json")
        self.assertTrue(checks["env"]["REVQORA_VERIFY_TIMINGS"].endswith("/" + upload["with"]["path"]))


    def test_linux_dependencies_use_bounded_shared_signed_installer(self):
        jobs = (self.ci['jobs']['build-and-test'], self.package['jobs']['package'])
        for job in jobs:
            steps = [s for s in job['steps'] if s.get('name') == 'Install Linux native dependencies']
            self.assertEqual(len(steps), 1)
            self.assertEqual(steps[0]['if'], "runner.os == 'Linux'")
            self.assertEqual(steps[0]['timeout-minutes'], '15')
            self.assertEqual(steps[0]['run'], 'sudo python3 scripts/install-linux-deps.py')
            self.assertNotIn('continue-on-error', steps[0])

    def test_dependency_cache_does_not_skip_installs_or_share_privileged_data(self):
        action = yaml.load((ROOT / '.github/actions/dependency-cache/action.yml').read_text(), Loader=yaml.BaseLoader)
        self.assertEqual(action['runs']['using'], 'composite')
        steps = action['runs']['steps']
        install = next(s for s in steps if s.get('run', '').startswith('npm ci'))
        self.assertEqual(install['run'], 'npm ci --prefer-offline')
        self.assertNotIn('if', install)
        self.assertNotIn('continue-on-error', install)
        fetch = next(s for s in steps if s.get('run', '').startswith('cargo fetch'))
        self.assertIn('--locked', fetch['run'])
        self.assertEqual(fetch['if'], "inputs.cargo == 'true'")
        self.assertNotIn('continue-on-error', fetch)
        caches = [s for s in steps if 'uses' in s]
        self.assertEqual(len(caches), 4)
        for step in caches:
            self.assertRegex(step['uses'], r'^actions/cache/(restore|save)@[0-9a-f]{40}$')
            self.assertEqual(step['continue-on-error'], 'true')
            self.assertNotIn('restore-keys', step['with'])
            paths = step['with']['path'].splitlines()
            self.assertIn(paths, [['${{ github.workspace }}/.ci-cache/npm/_cacache'], ['~/.cargo/registry/index', '~/.cargo/registry/cache']])
            if step['uses'].startswith('actions/cache/save@'):
                self.assertIn("github.ref == 'refs/heads/main'", step['if'])
                self.assertIn("github.event_name == 'push'", step['if'])
                self.assertIn("github.event_name == 'workflow_dispatch'", step['if'])
                self.assertIn("cache-hit != 'true'", step['if'])
            else:
                key = step['with']['key']
                self.assertIn('runner.os', key)
                self.assertIn('runner.arch', key)
                self.assertIn('hashFiles(', key)
                self.assertNotIn('github.sha', key)
                self.assertNotIn('github.run_id', key)

    def test_all_dependency_consumers_use_the_shared_action(self):
        cargo_jobs = [self.ci['jobs'][key] for key in ('build-and-test', 'windows-automation', 'windows-native-build')]
        cargo_jobs.append(self.package['jobs']['package'])
        for job in cargo_jobs:
            cache = [s for s in job['steps'] if s.get('uses') == './.github/actions/dependency-cache']
            self.assertEqual(len(cache), 1)
            self.assertEqual(cache[0]['with']['cargo'], 'true')
        smoke_cache = [s for s in self.ci['jobs']['windows-smoke']['steps'] if s.get('uses') == './.github/actions/dependency-cache']
        self.assertEqual(len(smoke_cache), 1)
        self.assertNotIn('with', smoke_cache[0])
        # The publisher only consumes verified exact-SHA artifacts, not caches.
        self.assertFalse(any('cache' in s.get('uses', '') for s in self.ci['jobs']['release']['steps']))
