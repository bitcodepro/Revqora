//! Physical history for safety decisions: ignore local replacement objects and grafts.
use super::runner::{self, GitResult};
use std::path::Path;

const ENV: [(&str, &str); 2] = [("GIT_NO_REPLACE_OBJECTS", "1"), ("GIT_GRAFT_FILE", if cfg!(windows) { "NUL" } else { "/dev/null" })];
pub fn run<I, S>(root: &Path, args: I) -> GitResult<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    runner::run_env(root, args, &ENV, None)
}
pub fn exec<I, S>(root: &Path, args: I) -> GitResult<runner::Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    runner::exec_full(root, args, &ENV, None)
}
