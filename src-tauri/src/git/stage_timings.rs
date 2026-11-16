//! Opt-in per-stage timings for read paths (history build, status, refs).
//!
//! Disabled unless the environment variable `REVQORA_STAGE_TIMINGS` names a file. Each
//! measured command then appends one JSON line to that local file, the same way
//! `REVQORA_VERIFY_TIMINGS` records verification stages. Nothing is sent anywhere.
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;

pub const ENV: &str = "REVQORA_STAGE_TIMINGS";

fn target() -> Option<PathBuf> {
    std::env::var_os(ENV).filter(|value| !value.is_empty()).map(PathBuf::from)
}

pub fn enabled() -> bool {
    target().is_some()
}

/// Named stage durations in milliseconds (fractional), in the order they were recorded.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Stages(pub Vec<(String, f64)>);

impl Stages {
    pub fn add(&mut self, name: &str, elapsed: Duration) {
        self.0.push((name.to_owned(), elapsed.as_secs_f64() * 1000.0));
    }

    /// Runs `f` and records its duration under `name`.
    pub fn time<T>(&mut self, name: &str, f: impl FnOnce() -> T) -> T {
        let started = Instant::now();
        let value = f();
        self.add(name, started.elapsed());
        value
    }

    pub fn get(&self, name: &str) -> Option<f64> {
        self.0.iter().find(|(stage, _)| stage == name).map(|(_, ms)| *ms)
    }
}

#[derive(Serialize)]
struct Line<'a> {
    at: u128,
    command: &'a str,
    repo: &'a str,
    stages: &'a [(String, f64)],
    detail: &'a str,
}

/// Appends one JSON line when timings are enabled. Write errors are ignored: timings
/// are diagnostics and must never fail the read they describe.
pub fn record(command: &str, repo: &Path, stages: &Stages, detail: &str) {
    let Some(path) = target() else { return };
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or_default();
    let line = Line { at, command, repo: &repo.to_string_lossy(), stages: &stages.0, detail };
    let Ok(mut text) = serde_json::to_string(&line) else { return };
    text.push('\n');
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(text.as_bytes());
    }
}
