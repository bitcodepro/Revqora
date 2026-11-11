#!/usr/bin/env python3
"""Install CI's native dependencies from fresh, signed Ubuntu indexes.

Runner images can contain stale package indexes and an unavailable Azure mirror.
Use canonical HTTPS archives and isolated indexes, without changing host sources.
The workflow bounds this step; each download has a timeout and bounded retries.
"""
from pathlib import Path
import os
import platform
import subprocess
import sys
import tempfile
import time

PACKAGES = (
    "libwebkit2gtk-4.1-dev", "build-essential", "libxdo-dev", "libssl-dev",
    "libayatana-appindicator3-dev", "librsvg2-dev", "patchelf",
)
KEYRING = "/usr/share/keyrings/ubuntu-archive-keyring.gpg"


def sources(architecture, release):
    if release.get("ID") != "ubuntu" or release.get("VERSION_CODENAME") != "noble":
        raise ValueError("Native CI dependencies require Ubuntu 24.04 (noble)")
    if architecture == "amd64":
        archive = "https://archive.ubuntu.com/ubuntu"
        security = "https://security.ubuntu.com/ubuntu"
    elif architecture == "arm64":
        archive = security = "https://ports.ubuntu.com/ubuntu-ports"
    else:
        raise ValueError(f"Unsupported CI architecture: {architecture}")
    return "\n".join(
        f"Types: deb\nURIs: {uri}\nSuites: {suites}\n"
        f"Components: main restricted universe multiverse\n"
        f"Architectures: {architecture}\nSigned-By: {KEYRING}\n"
        for uri, suites in ((archive, "noble noble-updates noble-backports"), (security, "noble-security"))
    )


def install(architecture, release, *, run=subprocess.run, sleep=time.sleep):
    source_text = sources(architecture, release)
    # One complete update/install retry recovers a mirror publication race (404).
    # Each attempt has fresh lists: a partial update can never reuse image indexes.
    for attempt in range(1, 4):
        print(f"::group::Linux native dependencies (attempt {attempt}/3)", flush=True)
        with tempfile.TemporaryDirectory(prefix="revqora-apt-") as temporary:
            root = Path(temporary)
            root.chmod(0o755)  # allow apt's unprivileged downloader to traverse it
            source = root / "ubuntu.sources"
            source.write_text(source_text, encoding="utf-8")
            source.chmod(0o644)
            lists = root / "lists"
            lists.mkdir(mode=0o755)
            options = [
                "apt-get", "-o", f"Dir::Etc::sourcelist={source}",
                "-o", "Dir::Etc::sourceparts=-", "-o", f"Dir::State::lists={lists}",
                "-o", f"Dir::Cache::pkgcache={root / 'pkgcache.bin'}",
                "-o", f"Dir::Cache::srcpkgcache={root / 'srcpkgcache.bin'}",
                "-o", "Acquire::Retries=2", "-o", "Acquire::http::Timeout=20",
                "-o", "Acquire::https::Timeout=20", "-o", "APT::Update::Error-Mode=any",
            ]
            env = {**os.environ, "DEBIAN_FRONTEND": "noninteractive"}
            updated = run([*options, "update"], env=env, check=False).returncode == 0
            installed = updated and run([*options, "install", "-y", *PACKAGES], env=env, check=False).returncode == 0
            print("::endgroup::", flush=True)
            if installed:
                return 0
        if attempt < 3:
            print("Refreshing package indexes before retrying failed preparation", flush=True)
            sleep(10 * attempt)
    print("::error::Linux native dependencies failed after three attempts", file=sys.stderr)
    return 1


def main():
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        raise SystemExit("Run with sudo python3 scripts/install-linux-deps.py")
    architecture = subprocess.check_output(["dpkg", "--print-architecture"], text=True).strip()
    return install(architecture, platform.freedesktop_os_release())


if __name__ == "__main__":
    sys.exit(main())
