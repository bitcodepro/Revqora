"""Revqora version selection, isolated packaging, verification and main-only publication.

Only the publish subcommand writes to GitHub. No subcommand moves existing tags.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]
RIDS = ("win-x64", "linux-x64", "linux-arm64", "osx-arm64", "osx-x64")
SEMVER = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?")


def run(args, **kwargs):
    env = {**os.environ, "PATH": str(Path.home() / ".cargo/bin") + os.pathsep + os.environ.get("PATH", "")}
    return subprocess.run(args, cwd=ROOT, check=True, env=env, **kwargs)


def version_tuple(version):
    match = SEMVER.fullmatch(version)
    if not match or (match[4] and any(re.fullmatch(r"0[0-9]+", part) for part in match[4].split("."))):
        raise ValueError("Expected SemVer without v or build metadata (e.g. 0.1.0 or 0.2.0-rc.1)")
    # Keep release versions representable by native bundle version fields.
    parts = tuple(map(int, match.groups()[:3]))
    if any(part > 65534 for part in parts):
        raise ValueError("Version components must fit native bundle versions")
    return parts


def select_version(tags, message="", bump="auto", explicit=""):
    stable = [version_tuple(tag[1:]) for tag in tags if re.fullmatch(r"v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", tag)]
    latest = max(stable, default=None)
    subject = message.splitlines()[0] if message else ""
    if explicit:
        parts = version_tuple(explicit)
        if "v" + explicit in tags:
            raise ValueError("Release tag already exists; immutable tags are never reused")
        if "-" not in explicit and latest is not None and parts <= latest:
            raise ValueError("Stable version must exceed the highest stable tag")
        version = explicit
    else:
        if "[skip release]" in subject.lower():
            return {"skip": "true"}
        if bump == "auto":
            bump = "major" if re.search(r"\[major\]|#major", subject, re.I) else "minor" if re.search(r"\[minor\]|#minor", subject, re.I) else "patch"
        if latest is None:
            parts = (0, 1, 0)
        elif bump == "major":
            parts = (latest[0] + 1, 0, 0)
        elif bump == "minor":
            parts = (latest[0], latest[1] + 1, 0)
        elif bump == "patch":
            parts = (latest[0], latest[1], latest[2] + 1)
        else:
            raise ValueError("Unknown version bump")
        version = ".".join(map(str, parts))
        version_tuple(version)
        if "v" + version in tags:
            raise ValueError("Release tag already exists")
    return {"skip": "false", "version": version, "tag": "v" + version, "prerelease": str("-" in version).lower()}


def outputs(values):
    for key, value in values.items():
        print(f"{key}={value}")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
            for key, value in values.items():
                stream.write(f"{key}={value}\n")


def extension(rid):
    return "tar.gz" if rid.startswith("linux-") else "zip"


def archive_name(version, rid):
    version_tuple(version)
    if rid not in RIDS:
        raise ValueError("Unsupported RID")
    return f"Revqora-{version}-{rid}.{extension(rid)}"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def executable_path(rid):
    if rid.startswith("osx-"):
        return "Revqora.app/Contents/MacOS/revqora"
    return "revqora.exe" if rid == "win-x64" else "revqora"


def validate_executable(header, rid):
    if rid == "win-x64":
        offset = struct.unpack_from("<I", header, 60)[0] if len(header) >= 64 else 0
        valid = header[:2] == b"MZ" and offset >= 64 and header[offset:offset + 6] == b"PE\0\0\x64\x86"
    elif rid.startswith("linux-"):
        valid = len(header) >= 20 and header[:6] == b"\x7fELF\x02\x01" and struct.unpack_from("<H", header, 18)[0] == (183 if rid == "linux-arm64" else 62)
    else:
        valid = len(header) >= 8 and header[:4] == b"\xcf\xfa\xed\xfe" and struct.unpack_from("<I", header, 4)[0] == (0x100000C if rid == "osx-arm64" else 0x1000007)
    if not valid:
        raise ValueError(f"Executable architecture does not match {rid}")


def safe_entry(name):
    path = PurePosixPath(name)
    if not name or "\\" in name or ":" in name or path.is_absolute() or ".." in path.parts:
        raise ValueError(f"Unsafe archive path: {name}")
    lower = tuple(part.lower() for part in path.parts)
    if any(part in (".git", "data", ".env", "obj", "bin") or part.endswith(".dsym") for part in lower) or path.suffix.lower() in (".key", ".pem", ".pfx", ".p12", ".db", ".sqlite", ".sqlite3", ".log", ".pdb", ".dbg"):
        raise ValueError(f"Local data or build residue in package: {name}")


def verify_archive(archive, version, rid, commit):
    expected = archive_name(version, rid)
    if archive.name != expected:
        raise ValueError("Archive filename mismatch")
    checksum = archive.with_name(archive.name + ".sha256")
    line = checksum.read_text(encoding="ascii").strip()
    if line != f"{digest(archive)}  {expected}":
        raise ValueError(f"SHA-256 mismatch or invalid checksum filename: {expected}")
    required = {"README.md", "LICENSE", NOTICES, "build-info.json", executable_path(rid), *("licenses/" + name for name in FONT_LICENSES)}
    if rid.startswith("osx-"):
        required.add("Revqora.app/Contents/Info.plist")
    with zipfile.ZipFile(archive) if extension(rid) == "zip" else tarfile.open(archive, "r:gz") as bundle:
        entries = bundle.infolist() if isinstance(bundle, zipfile.ZipFile) else bundle.getmembers()
        files = {}
        for entry in entries:
            name = entry.filename if isinstance(bundle, zipfile.ZipFile) else entry.name
            safe_entry(name)
            if name in files:
                raise ValueError("Duplicate archive entry")
            mode = entry.external_attr >> 16 if isinstance(bundle, zipfile.ZipFile) else entry.mode
            is_dir = entry.is_dir() if isinstance(bundle, zipfile.ZipFile) else entry.isdir()
            if isinstance(bundle, zipfile.ZipFile):
                if stat.S_ISLNK(mode):
                    raise ValueError("Symlinks are not allowed in packages")
            elif not (entry.isfile() or is_dir):
                raise ValueError("Links/devices are not allowed in packages")
            if not is_dir:
                files[name] = entry
        if not required <= files.keys():
            raise ValueError(f"Missing package entries: {sorted(required - files.keys())}")
        extra = sorted({name.split("/")[0] for name in files} - TOP_LEVEL)
        if extra:
            raise ValueError(f"Unexpected top-level package entries: {extra}")
        allowed = required | {"Revqora.app/Contents/Info.plist"}
        unexpected = [name for name in files if name not in allowed and not (rid.startswith("osx-") and name.startswith("Revqora.app/Contents/"))]
        if unexpected:
            raise ValueError(f"Unexpected package entries: {unexpected}")

        def read(name, limit=65536):
            stream = bundle.open(files[name]) if isinstance(bundle, zipfile.ZipFile) else bundle.extractfile(files[name])
            with stream:
                return stream.read(limit)

        manifest = json.loads(read("build-info.json"))
        if manifest != {"version": version, "rid": rid, "commit": commit}:
            raise ValueError("Package source/version/RID mismatch")
        if b"MIT License" not in read("LICENSE") or b"Copyright (c) 2026 Revqora contributors" not in read("LICENSE"):
            raise ValueError("Missing Revqora MIT copyright")
        for font in FONT_LICENSES:
            if b"SIL OPEN FONT LICENSE" not in read("licenses/" + font).upper():
                raise ValueError("Missing embedded font license")
        notices = read(NOTICES, 16 * 1024 * 1024)
        if not all(component in notices for component in (b"Tauri", b"React", b"SIL Open Font License")):
            raise ValueError("Third-party notices are incomplete")
        validate_executable(read(executable_path(rid), 8192), rid)
        executable = files[executable_path(rid)]
        mode = executable.external_attr >> 16 if isinstance(bundle, zipfile.ZipFile) else executable.mode
        if rid != "win-x64" and not mode & 0o111:
            raise ValueError("Unix executable permission is missing")
        if rid.startswith("osx-"):
            info = plistlib.loads(read("Revqora.app/Contents/Info.plist"))
            if info.get("CFBundleShortVersionString") != version or info.get("CFBundleExecutable") != "revqora":
                raise ValueError("Invalid macOS bundle version/executable")
    print(f"PASS {expected}: SHA-256, contents, source, version and architecture")


def verify_packages(directory, version, commit, rids=RIDS):
    expected = {name for rid in rids for name in (archive_name(version, rid), archive_name(version, rid) + ".sha256")}
    actual = {path.name for path in directory.iterdir()}
    if actual != expected:
        raise ValueError(f"Expected exactly the archive/checksum pairs; missing={sorted(expected - actual)}, extra={sorted(actual - expected)}")
    for rid in rids:
        verify_archive(directory / archive_name(version, rid), version, rid, commit)
    return [directory / name for name in sorted(expected)]


NOTICES = "THIRD_PARTY_NOTICES.md"
TOP_LEVEL = {"README.md", "LICENSE", NOTICES, "build-info.json", "revqora.exe", "revqora", "Revqora.app", "licenses"}
FONT_LICENSES = ("Inter-LICENSE.txt", "JetBrainsMono-LICENSE.txt")


def package(directory, version, rid):
    name = archive_name(version, rid)
    directory = directory.resolve()
    if not directory.is_relative_to(ROOT / "dist"):
        raise ValueError("Package output must be inside this checkout's dist/ directory")
    expected_host = "win32" if rid.startswith("win-") else "darwin" if rid.startswith("osx-") else "linux"
    if sys.platform != expected_host:
        raise ValueError("Release packages require a native package host")
    archive = directory / name
    if archive.exists() or archive.with_name(name + ".sha256").exists():
        raise FileExistsError("Use an empty output directory; packages are not silently replaced")
    commit = run(["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    # Isolate generated bundles from prior build output. The source manifests stay unchanged.
    config = json.dumps({"version": version, "bundle": {"active": rid.startswith("osx-")}})
    node = shutil.which("node")
    if node is None:
        raise FileNotFoundError("Node.js is required")
    build = [node, str(ROOT / "node_modules/@tauri-apps/cli/tauri.js"), "build", "--config", config]
    build += ["--bundles", "app"] if rid.startswith("osx-") else ["--no-bundle"]
    run(build)
    # Vite cleans frontend dist/ during beforeBuildCommand, including package directories.
    directory.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".package-{rid}-", dir=directory.parent) as temporary:
        staging = Path(temporary)
        release = ROOT / "src-tauri/target/release"
        if rid.startswith("osx-"):
            app = release / "bundle/macos/Revqora.app"
            shutil.copytree(app, staging / "Revqora.app", symlinks=True)
            run(["codesign", "--force", "--deep", "--sign", "-", str(staging / "Revqora.app")])
            run(["codesign", "--verify", "--deep", "--strict", str(staging / "Revqora.app")])
        else:
            shutil.copyfile(release / executable_path(rid), staging / executable_path(rid))
        for doc in ("README.md", "LICENSE", NOTICES):
            shutil.copyfile(ROOT / doc, staging / doc)
        licenses = staging / "licenses"
        licenses.mkdir()
        for package_name, filename in (("inter", FONT_LICENSES[0]), ("jetbrains-mono", FONT_LICENSES[1])):
            shutil.copyfile(ROOT / f"node_modules/@fontsource-variable/{package_name}/LICENSE", licenses / filename)
        (staging / "build-info.json").write_text(json.dumps({"version": version, "rid": rid, "commit": commit}) + "\n", encoding="utf-8")
        executable = staging / executable_path(rid)
        executable.chmod(executable.stat().st_mode | 0o111)
        for file in staging.rglob("*"):
            safe_entry(file.relative_to(staging).as_posix())
            if file.is_symlink():
                raise ValueError("Links are not allowed in packages")
        if extension(rid) == "zip":
            with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED) as bundle:
                for file in sorted(staging.rglob("*")):
                    if file.is_file():
                        bundle.write(file, file.relative_to(staging).as_posix())
        else:
            with tarfile.open(archive, "x:gz") as bundle:
                for file in sorted(staging.rglob("*")):
                    if file.is_file():
                        relative = file.relative_to(staging).as_posix()
                        entry = bundle.gettarinfo(str(file), arcname=relative)
                        entry.mode = 0o755 if relative == executable_path(rid) else 0o644
                        with file.open("rb") as stream:
                            bundle.addfile(entry, stream)
    archive.with_name(name + ".sha256").write_text(f"{digest(archive)}  {name}\n", encoding="ascii")
    verify_archive(archive, version, rid, commit)
    outputs({"archive": archive.as_posix(), "checksum": archive.as_posix() + ".sha256"})


def gh_api(path, method="GET", data=None):
    args = ["gh", "api", "--method", method, f"repos/bitcodepro/Revqora/{path}"]
    if data is not None:
        args += ["--input", "-"]
    response = run(args, input=None if data is None else json.dumps(data), capture_output=True, text=True)
    return json.loads(response.stdout)


def releases():
    result = []
    page = 1
    while True:
        batch = gh_api(f"releases?per_page=100&page={page}")
        result.extend(batch)
        if len(batch) < 100:
            return result
        page += 1


def find_draft(tag, attempts=10, delay=3.0):
    """The release list is eventually consistent: a just-created draft can be missing for a few seconds.
    (The tag endpoint only promises published releases, so the list is the only way to see our draft.)"""
    for attempt in range(attempts):
        release = next((item for item in releases() if item["tag_name"] == tag), None)
        if release is not None:
            return release
        if attempt < attempts - 1:
            time.sleep(delay)
    raise ValueError(f"Draft for {tag} did not appear in the release list; draft retained for inspection")


def publish(directory, version, env):
    commit = env.get("GITHUB_SHA", "")
    if (env.get("GITHUB_ACTIONS") != "true" or env.get("GITHUB_REPOSITORY") != "bitcodepro/Revqora" or env.get("GITHUB_REF") != "refs/heads/main" or env.get("GITHUB_EVENT_NAME") not in ("push", "workflow_dispatch") or env.get("GITHUB_WORKFLOW_REF") != "bitcodepro/Revqora/.github/workflows/ci.yml@refs/heads/main" or not re.fullmatch(r"[0-9a-f]{40}", commit)):
        raise ValueError("Publication requires Revqora's CI workflow on main with an exact source SHA")
    version_tuple(version)
    files = verify_packages(directory, version, commit)
    if gh_api("git/ref/heads/main")["object"]["sha"] != commit:
        raise ValueError("main moved since this build; publish from the current main run")
    tags = [ref["ref"].removeprefix("refs/tags/") for ref in gh_api("git/matching-refs/tags/v")]
    select_version(tags, explicit=version)  # Refuse collisions and stable version regression before writing.
    tag = "v" + version
    if any(item["tag_name"] == tag for item in releases()):
        raise ValueError("A release/draft already exists for this version; inspect it instead of overwriting")
    gh_api("git/refs", "POST", {"ref": f"refs/tags/{tag}", "sha": commit})
    args = ["gh", "release", "create", tag, "--repo", "bitcodepro/Revqora", "--verify-tag", "--target", commit, "--title", f"Revqora {tag}", "--generate-notes", "--draft"]
    if "-" in version:
        args.append("--prerelease")
    run(args + [str(file) for file in files])
    release = find_draft(tag)
    actual = {asset["name"]: asset["size"] for asset in release["assets"]}
    if actual != {file.name: file.stat().st_size for file in files}:
        raise ValueError("Release asset upload is incomplete; draft retained for inspection")
    run(["gh", "release", "edit", tag, "--repo", "bitcodepro/Revqora", "--draft=false", f"--latest={str('-' not in version).lower()}"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("version")
    for name in ("package", "verify", "publish"):
        sub = commands.add_parser(name)
        sub.add_argument("--directory", type=Path, default=ROOT / "dist/packages")
        sub.add_argument("--version", required=True)
        if name == "package":
            sub.add_argument("--rid", choices=RIDS, required=True)
        elif name == "verify":
            sub.add_argument("--rid", choices=RIDS)
            sub.add_argument("--commit", required=True)
    args = parser.parse_args()
    if args.command == "version":
        tags = run(["git", "tag", "--list", "v*"], capture_output=True, text=True).stdout.splitlines()
        message = os.environ.get("COMMIT_MESSAGE") or run(["git", "log", "-1", "--format=%s"], capture_output=True, text=True).stdout
        outputs(select_version(tags, message, os.environ.get("BUMP", "auto"), os.environ.get("RELEASE_VERSION", "")))
    elif args.command == "package":
        package(args.directory, args.version, args.rid)
    elif args.command == "verify":
        verify_packages(args.directory, args.version, args.commit, (args.rid,) if args.rid else RIDS)
    else:
        publish(args.directory, args.version, os.environ)


if __name__ == "__main__":
    main()
