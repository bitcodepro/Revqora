//! Opt-in stage timings: nothing is written unless REVQORA_STAGE_TIMINGS names a file.
//! Its own test binary, because the switch is a process-wide environment variable.
use std::fs;

use revqora_lib::git::graph::{self, ViewScope};
use revqora_lib::git::{refs, runner, stage_timings, status};

#[test]
fn stage_timings_are_recorded_only_when_enabled() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["config", "user.name", "Tester"],
        &["config", "user.email", "tester@example.com"],
        &["config", "commit.gpgsign", "false"],
        &["commit", "-q", "--allow-empty", "-m", "first"],
    ] {
        runner::run(root, args).unwrap();
    }
    let scope = || ViewScope { branch: Some("HEAD"), show_incoming: false, context: None };

    // Off: stages are still measured for the build result, but no file is written.
    let log = dir.path().join("timings").join("stages.jsonl");
    std::env::remove_var(stage_timings::ENV);
    let built = graph::refresh_for_view_timed(root, scope(), false, 100, false, None, None).unwrap();
    for stage in ["refResolution", "gitWalk", "localOnly", "laneLayout", "decorationsAndRows", "build"] {
        assert!(built.stages.get(stage).is_some_and(|ms| ms >= 0.0), "{stage}");
    }
    status::status(root).unwrap();
    assert!(!log.exists());

    fs::create_dir_all(log.parent().unwrap()).unwrap();
    std::env::set_var(stage_timings::ENV, &log);
    status::status(root).unwrap();
    refs::snapshot(root).unwrap();
    let mut stages = stage_timings::Stages::default();
    stages.time("exactCount", || ());
    stage_timings::record("graph_load", root, &stages, "rows=1");
    std::env::remove_var(stage_timings::ENV);

    let text = fs::read_to_string(&log).unwrap();
    let lines: Vec<serde_json::Value> = text.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    let commands: Vec<_> = lines.iter().map(|line| line["command"].as_str().unwrap().to_owned()).collect();
    assert_eq!(commands, ["status", "refs_snapshot", "graph_load"]);
    let names = |index: usize| lines[index]["stages"].as_array().unwrap().iter().map(|pair| pair[0].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    assert_eq!(names(0), ["gitStatus", "parse", "stateTokens"]);
    assert!(names(1).contains(&"enumerationWithUpstreamTrack".to_owned()));
    assert_eq!(names(2), ["exactCount"]);
}
