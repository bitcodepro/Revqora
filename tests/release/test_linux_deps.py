import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("linux_deps", ROOT / "scripts/install-linux-deps.py")
linux_deps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(linux_deps)
UBUNTU = {"ID": "ubuntu", "VERSION_CODENAME": "noble"}


class LinuxDependencyTests(unittest.TestCase):
    def test_canonical_signed_sources_for_both_architectures(self):
        for arch, host in (("amd64", "archive.ubuntu.com/ubuntu"), ("arm64", "ports.ubuntu.com/ubuntu-ports")):
            with self.subTest(arch=arch):
                source = linux_deps.sources(arch, UBUNTU)
                self.assertIn(f"https://{host}", source)
                self.assertIn("noble-security", source)
                self.assertIn("noble-updates", source)
                self.assertEqual(source.count(f"Signed-By: {linux_deps.KEYRING}"), 2)
                self.assertIn(f"Architectures: {arch}", source)
                for unsafe in ("azure.archive", "http:", "Trusted:", "Allow-Insecure:"):
                    self.assertNotIn(unsafe, source)
        self.assertIn("https://security.ubuntu.com/ubuntu", linux_deps.sources("amd64", UBUNTU))

    def test_rejects_unknown_release_and_architecture_before_running_apt(self):
        for arch, release in (("riscv64", UBUNTU), ("amd64", {"ID": "debian", "VERSION_CODENAME": "noble"}), ("amd64", {"ID": "ubuntu", "VERSION_CODENAME": "jammy"})):
            with self.subTest(arch=arch, release=release), self.assertRaises(ValueError):
                linux_deps.install(arch, release, run=lambda *a, **k: self.fail("apt must not run"))

    def exercise(self, responses):
        calls = []
        paths = []
        pauses = []
        def run(command, **kwargs):
            calls.append(command)
            self.assertFalse(kwargs["check"])
            self.assertEqual(kwargs["env"]["DEBIAN_FRONTEND"], "noninteractive")
            self.assertIn("APT::Update::Error-Mode=any", command)
            self.assertIn("Acquire::Retries=2", command)
            self.assertIn("Acquire::https::Timeout=20", command)
            self.assertIn("Dir::Etc::sourceparts=-", command)
            source = Path(next(c.split("=", 1)[1] for c in command if c.startswith("Dir::Etc::sourcelist=")))
            self.assertIn("Signed-By:", source.read_text())
            lists = Path(next(c.split("=", 1)[1] for c in command if c.startswith("Dir::State::lists=")))
            self.assertEqual(lists.parent, source.parent)
            self.assertTrue(lists.is_dir())
            paths.append(source.parent)
            return SimpleNamespace(returncode=responses[len(calls) - 1])
        result = linux_deps.install("amd64", UBUNTU, run=run, sleep=pauses.append)
        self.assertTrue(all(not path.exists() for path in paths))
        return result, calls, paths, pauses

    def test_success_keeps_exact_dependency_list(self):
        result, calls, paths, pauses = self.exercise([0, 0])
        self.assertEqual(result, 0)
        self.assertEqual(calls[0][-1], "update")
        self.assertEqual(calls[1][-9:], ["install", "-y", *linux_deps.PACKAGES])
        self.assertEqual(paths[0], paths[1])
        self.assertEqual(pauses, [])

    def test_failed_update_never_installs_stale_indexes(self):
        result, calls, paths, pauses = self.exercise([100, 0, 0])
        self.assertEqual(result, 0)
        self.assertEqual([calls[0][-1], calls[1][-1]], ["update", "update"])
        self.assertNotEqual(paths[0], paths[1])
        self.assertEqual(pauses, [10])

    def test_404_install_refreshes_all_indexes_before_retry(self):
        result, calls, paths, pauses = self.exercise([0, 100, 0, 0])
        self.assertEqual(result, 0)
        self.assertEqual(calls[2][-1], "update")
        self.assertNotEqual(paths[1], paths[2])
        self.assertEqual(pauses, [10])

    def test_persistent_failure_is_bounded_and_nonzero(self):
        result, calls, paths, pauses = self.exercise([100, 100, 100])
        self.assertEqual(result, 1)
        self.assertEqual(len(calls), 3)
        self.assertEqual(len(set(paths)), 3)
        self.assertEqual(pauses, [10, 20])
