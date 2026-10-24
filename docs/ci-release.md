# CI and releases

The workflows adapt bitcodepro/Typlo's release process to Revqora's Tauri 2,
Rust, React and TypeScript stack. Every checkout uses the event's exact SHA and
does not persist credentials. Actions are pinned to commit SHAs. Jobs have
`contents: read`; only the final publication job on `bitcodepro/Revqora` main
has `contents: write`. No additional repository secrets are required.

## Checks and packages

- Windows 2025, Ubuntu 24.04 and macOS 15 run `npm ci` and
  `npm run verify:quick`: Rust format, clippy, Rust unit and Git workflow tests,
  TypeScript typecheck and frontend unit tests.
- A separate Windows job runs the complete `npm run verify`, including a release
  build, the existing portable zip script and the real WebView2 UI smoke test.
  It locates the WebView2 Runtime or installs Microsoft's Evergreen Runtime
  bootstrapper on the disposable runner, and passes the runtime path to the test.
  A debug-app startup probe checks native CDP connectivity before release compilation.
  The test uses disposable repositories and a separate WebView2 profile.
  On Windows the profile is created in the native per-user Temp folder, separate
  from the runner's workspace drive; inherited browser options are preserved.
- Release tooling tests exercise version selection, archive and checksum
  validation, wrong architectures, traversal, links, unexpected files, source
  mismatches, publication guards, immutable tags and interrupted draft uploads.
- Packages build natively for `win-x64`, `linux-x64`, `linux-arm64`,
  `osx-arm64` and `osx-x64`. Linux uses `.tar.gz`; Windows and macOS use `.zip`.
  macOS ships the Tauri-generated `Revqora.app` with its ad-hoc signature.
  No signing certificate or notarization is introduced.
- Each archive includes the application, README, MIT LICENSE,
  `THIRD_PARTY_NOTICES.md`, embedded font license texts, and `build-info.json`
  identifying the source commit, version and platform. Package verification
  checks the SHA-256 sidecar, required contents, executable architecture,
  Unix execute permissions and embedded source metadata. It rejects traversal,
  links, unexpected files and common local data/build artifacts.
- A separate job downloads and verifies all five archive/checksum pairs before
  publication. Preview artifacts are retained for seven days.

The existing local `npm run package` remains the Windows portable packaging
command. CI uses `scripts/release.py package` to produce versioned packages with
checksums and source metadata. The release version is passed to Tauri through
its configuration override; source version files are not bumped by a workflow.

Git is a system prerequisite and is never bundled. Windows requires WebView2.
Linux archives contain the native executable and need WebKitGTK 4.1 and the
platform's GTK/system libraries; they are not self-contained AppImages. macOS
packages are not notarized. Real desktop validation on each platform remains
necessary; archive checks do not exercise the Linux or macOS UI. The first
hosted workflow run must validate these newly prepared native build paths.

Jobs have bounded timeouts after a runner starts. Runner queue time and hosted
ARM/macOS capacity are controlled by GitHub. npm uses `package-lock.json` and
Rust uses `src-tauri/Cargo.lock`; the Rust stable toolchain is installed with
rustfmt and clippy.

## Version selection and publication

The first release is `v0.1.0`. Subsequent main runs bump the highest stable
`vMAJOR.MINOR.PATCH` tag's patch by default. Only the first commit-message line
(the PR title with squash merge) controls these overrides:

- `[minor]` or `#minor`: next minor version.
- `[major]` or `#major`: next major version.
- `[skip release]`: checks only, without packages or publication on main.

Manual dispatch on main accepts a bump or an explicit SemVer such as
`0.2.0-rc.1`. Explicit versions take precedence. Stable versions must increase;
existing tags and drafts are never overwritten. Prereleases do not become
latest. PRs and dispatches on other branches only produce
`0.0.0-pr.<number>` preview artifacts. Documentation-only main pushes are ignored,
matching Typlo.

The publisher verifies its repository, workflow, event, ref and source SHA,
revalidates downloaded packages and requires current main to still equal the
tested SHA. It reserves a new immutable lightweight `v*` tag, creates a draft,
uploads all ten assets, checks their names and sizes, and then publishes.
If main advanced, the run fails before reserving a tag. If upload or publication
fails afterwards, the tag/draft remains for inspection. Do not delete or move
tags, or blindly rerun a version after such a failure.

## Local commands

```text
npm ci
npm run verify
python -m pip install PyYAML==6.0.3
python -B -m unittest discover -s tests/release -v
python scripts/release.py package --rid win-x64 --version 0.1.0 --directory dist/local-packages
python scripts/release.py verify --rid win-x64 --version 0.1.0 --directory dist/local-packages --commit <git-HEAD>
```

Use an empty package output directory and the matching native OS. Packaging and
verification do not publish. `publish` refuses an ordinary local session.

## Repository protection

Repository settings and rulesets are separate from these workflow files.
Typlo's current default-branch ruleset requires a PR, prevents deletion and
non-fast-forward pushes, has no bypass actors, and requires zero approving
reviews. It does not require CI status checks or CODEOWNERS review. Its `v*`
tag ruleset forbids tag updates and deletion. These facts must not be described
as enforcing the owner's personal approval. Applying the matching security and
access settings is a separate, reviewed setup step.
