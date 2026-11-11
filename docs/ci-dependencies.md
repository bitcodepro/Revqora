# CI dependency downloads

The shared `.github/actions/dependency-cache` action caches downloads, not installed
applications or compiled output. It is used by all npm consumers and fetches Rust
dependencies in jobs which compile Rust.

- npm: only `.ci-cache/npm/_cacache`; `npm ci --prefer-offline` still runs on every
  job and enforces `package-lock.json`.
- Cargo: only `~/.cargo/registry/index` and `~/.cargo/registry/cache`. A complete
  `cargo fetch --locked` avoids a partial immutable cache saved by a faster matrix
  job. Unpacked sources, `target`, credentials, global config and toolchains are
  deliberately excluded. The current lockfile has no Git dependencies.
- Keys include an explicit schema version, OS, architecture and lockfile hash.
  npm keys also include Node's configured major version; Cargo includes its
  manifest hash. Changing the Node major requires changing the npm key.
- Restore is allowed on PRs; only trusted `push`/`workflow_dispatch` runs on main
  save. No secrets belong in cached paths. The release publisher does not restore
  dependency caches and still validates exact-commit packages and checksums.
- Cache errors are treated as misses. Installation, fetching, all tests and
  release gates remain mandatory. Concurrent main jobs may race to save the same
  immutable key; the first successful save wins and the others may warn.

GitHub normally evicts caches after seven days without access; this is not a
fixed seven-day TTL or an offline guarantee. Storage pressure can evict earlier.
No paid cache limits are changed. Compare cold/warm preparation timings and the
actual cache sizes before adding larger caches. Download caches do not eliminate
Rust compilation or Windows UI test time.

## Linux preparation

`scripts/install-linux-deps.py` uses canonical signed Ubuntu 24.04 HTTPS archives,
fresh isolated indexes, strict update error handling, bounded download retries,
and a 15-minute workflow step budget. A failed update cannot continue with stale
runner-image indexes. A failed install retries from fresh indexes, which also
handles package publication races. Host sources and trust settings are unchanged.

APT `.deb` caching is not included in this first change. Reusing downloaded native
packages safely requires a separate version manifest tied to runner image and
architecture and validation against fresh signed metadata. Blindly restoring
installed `/usr`, dpkg state, old indexes or unverified `.deb` files is not safe.
This would not remove the need for fresh metadata/security updates anyway.

Node/Python hosted toolcache behavior, Rust stable selection, and the signed
Evergreen WebView2 preparation remain unchanged. Neither registry outages nor
all external runtime downloads can be removed by dependency caching.
