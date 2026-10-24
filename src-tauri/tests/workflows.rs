//! End-to-end checks of the git backend against real temporary repositories.

use std::fs;
use std::path::{Path, PathBuf};

use revqora_lib::git::conflicts;
use revqora_lib::git::diff::{self, DiffOptions, SelectionMode, WorkSide};
use revqora_lib::git::graph;
use revqora_lib::git::layers;
use revqora_lib::git::ops::{self, CommitOptions, RewriteAction};
use revqora_lib::git::repo;
use revqora_lib::git::runner;
use revqora_lib::git::status;

struct Repo {
    _dir: tempfile::TempDir,
    path: PathBuf,
}

impl Repo {
    fn new() -> Repo {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("repo");
        fs::create_dir_all(&path).unwrap();
        runner::run(&path, ["init", "-q", "-b", "main"]).unwrap();
        runner::run(&path, ["config", "user.name", "Tester"]).unwrap();
        runner::run(&path, ["config", "user.email", "tester@example.com"]).unwrap();
        runner::run(&path, ["config", "core.autocrlf", "false"]).unwrap();
        runner::run(&path, ["config", "commit.gpgsign", "false"]).unwrap();
        Repo { _dir: dir, path }
    }
    fn p(&self) -> &Path {
        &self.path
    }
    fn write(&self, name: &str, content: &str) {
        let f = self.path.join(name);
        if let Some(parent) = f.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(f, content).unwrap();
    }
    fn read(&self, name: &str) -> String {
        fs::read_to_string(self.path.join(name)).unwrap()
    }
    fn git(&self, args: &[&str]) -> String {
        runner::run(&self.path, args).unwrap()
    }
    fn commit_all(&self, msg: &str) -> String {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", msg]);
        self.git(&["rev-parse", "HEAD"]).trim().to_string()
    }
    fn index_blob(&self, name: &str) -> String {
        runner::run(&self.path, ["show", &format!(":{name}")]).unwrap_or_default()
    }
    fn head_blob(&self, name: &str) -> String {
        runner::run(&self.path, ["show", &format!("HEAD:{name}")]).unwrap_or_default()
    }
}

fn opts() -> DiffOptions {
    DiffOptions::default()
}

fn select_lines(d: &diff::FileDiff, pred: impl Fn(&str, &str) -> bool) -> Vec<(usize, usize)> {
    let mut v = Vec::new();
    for (hi, h) in d.hunks.iter().enumerate() {
        for (li, l) in h.lines.iter().enumerate() {
            if pred(&l.kind, &l.text) {
                v.push((hi, li));
            }
        }
    }
    v
}

#[test]
fn stage_unstage_and_discard_single_lines() {
    let r = Repo::new();
    r.write("f.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
    r.commit_all("init");
    r.write("f.txt", "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n");

    let d = diff::working_diff(r.p(), "f.txt", WorkSide::Unstaged, None, false, &opts()).unwrap();
    assert_eq!(d.hunks.len(), 2);
    // Stage only the first change.
    let sel = select_lines(&d, |k, t| (k == "-" && t == "one") || (k == "+" && t == "ONE"));
    diff::apply_selection(r.p(), "f.txt", SelectionMode::Stage, &sel, &d.hash, None, false, &opts()).unwrap();
    assert!(r.index_blob("f.txt").starts_with("ONE\ntwo"));
    assert!(r.index_blob("f.txt").ends_with("nine\nten\n"));

    // Unstage it again by line.
    let s = diff::working_diff(r.p(), "f.txt", WorkSide::Staged, None, false, &opts()).unwrap();
    let sel = select_lines(&s, |k, _| k != " ");
    diff::apply_selection(r.p(), "f.txt", SelectionMode::Unstage, &sel, &s.hash, None, false, &opts()).unwrap();
    assert_eq!(r.index_blob("f.txt"), r.head_blob("f.txt"));

    // Discard only the last change from the working tree.
    let d = diff::working_diff(r.p(), "f.txt", WorkSide::Unstaged, None, false, &opts()).unwrap();
    let sel = select_lines(&d, |k, t| (k == "-" && t == "ten") || (k == "+" && t == "TEN"));
    diff::apply_selection(r.p(), "f.txt", SelectionMode::Discard, &sel, &d.hash, None, false, &opts()).unwrap();
    assert_eq!(r.read("f.txt"), "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
}

#[test]
fn stale_selection_is_refused() {
    let r = Repo::new();
    r.write("f.txt", "a\n");
    r.commit_all("init");
    r.write("f.txt", "b\n");
    let d = diff::working_diff(r.p(), "f.txt", WorkSide::Unstaged, None, false, &opts()).unwrap();
    r.write("f.txt", "c\n");
    let err = diff::apply_selection(r.p(), "f.txt", SelectionMode::Stage, &[(0, 0), (0, 1)], &d.hash, None, false, &opts()).unwrap_err();
    assert_eq!(err.kind, "stale");
}

#[test]
fn partial_stage_of_untracked_file() {
    let r = Repo::new();
    r.write("base.txt", "x\n");
    r.commit_all("init");
    r.write("new.txt", "keep1\nskip\nkeep2\n");
    let d = diff::working_diff(r.p(), "new.txt", WorkSide::Unstaged, None, true, &opts()).unwrap();
    assert!(d.is_new);
    let sel = select_lines(&d, |k, t| k == "+" && t != "skip");
    diff::apply_selection(r.p(), "new.txt", SelectionMode::Stage, &sel, &d.hash, None, true, &opts()).unwrap();
    assert_eq!(r.index_blob("new.txt"), "keep1\nkeep2\n");
}

#[test]
fn status_reports_staged_unstaged_untracked() {
    let r = Repo::new();
    r.write("a.txt", "a\n");
    r.write("b.txt", "b\n");
    r.commit_all("init");
    r.write("a.txt", "a2\n");
    r.git(&["add", "a.txt"]);
    r.write("b.txt", "b2\n");
    r.write("c.txt", "c\n");
    let s = status::status(r.p()).unwrap();
    assert_eq!(s.branch.as_deref(), Some("main"));
    assert_eq!((s.staged_count, s.unstaged_count, s.conflict_count), (1, 2, 0));
}

#[test]
fn stage_layers_unstage_bottom_layer_keeps_top() {
    let r = Repo::new();
    r.write("a.txt", "a\n");
    r.write("b.txt", "b\n");
    r.commit_all("init");

    r.write("a.txt", "a changed\n");
    ops::stage_paths(r.p(), &["a.txt".into()]).unwrap();
    layers::seal(r.p(), Some("first")).unwrap();

    r.write("b.txt", "b changed\n");
    ops::stage_paths(r.p(), &["b.txt".into()]).unwrap();
    layers::seal(r.p(), None).unwrap();

    let st = layers::state(r.p()).unwrap();
    assert!(st.active);
    assert_eq!(st.layers.len(), 2);
    assert_eq!(st.layers[0].name, "first");
    assert_eq!(st.layers[0].files[0].path, "a.txt");
    assert_eq!(st.layers[1].files[0].path, "b.txt");
    assert!(st.open_files.is_empty());

    // Unstage the first layer: only b stays staged; the working tree keeps both changes.
    layers::unstage(r.p(), 0, &Default::default()).unwrap();
    assert_eq!(r.index_blob("a.txt"), "a\n");
    assert_eq!(r.index_blob("b.txt"), "b changed\n");
    assert_eq!(r.read("a.txt"), "a changed\n");
    let st = layers::state(r.p()).unwrap();
    assert_eq!(st.layers.len(), 1);
    assert_eq!(st.layers[0].files[0].path, "b.txt");

    // Discard the remaining layer: removed from index and working tree.
    layers::discard(r.p(), 0).unwrap();
    assert_eq!(r.index_blob("b.txt"), "b\n");
    assert_eq!(r.read("b.txt"), "b\n");
    assert!(!layers::state(r.p()).unwrap().active);
}

#[test]
fn stage_layers_open_layer_and_dependent_conflict() {
    let r = Repo::new();
    r.write("f.txt", "v1\n");
    r.commit_all("init");

    r.write("f.txt", "v2\n");
    ops::stage_paths(r.p(), &["f.txt".into()]).unwrap();
    layers::seal(r.p(), None).unwrap();

    // Second change of the same line, staged in the open layer.
    r.write("f.txt", "v3\n");
    ops::stage_paths(r.p(), &["f.txt".into()]).unwrap();
    let st = layers::state(r.p()).unwrap();
    assert_eq!(st.layers.len(), 1);
    assert_eq!(st.open_files.len(), 1);

    // Diff of the open layer is computed against the top layer.
    let base = layers::staged_base(r.p());
    let d = diff::working_diff(r.p(), "f.txt", WorkSide::Staged, base.as_deref(), false, &opts()).unwrap();
    assert!(d.hunks[0].lines.iter().any(|l| l.kind == "-" && l.text == "v2"));

    // Removing layer 1 conflicts with the open layer that edits the same line.
    let err = layers::unstage(r.p(), 0, &Default::default()).unwrap_err();
    assert_eq!(err.kind, "layer-conflict");
    assert_eq!(err.details, vec!["f.txt".to_string()]);
    // Nothing changed.
    assert_eq!(r.index_blob("f.txt"), "v3\n");

    // Unstaging the open layer returns the index to layer 1.
    layers::unstage(r.p(), 1, &Default::default()).unwrap();
    assert_eq!(r.index_blob("f.txt"), "v2\n");
}

#[test]
fn stage_layers_commit_top_layer_alone() {
    let r = Repo::new();
    r.write("a.txt", "a\n");
    r.write("b.txt", "b\n");
    r.commit_all("init");
    r.write("a.txt", "A\n");
    ops::stage_paths(r.p(), &["a.txt".into()]).unwrap();
    layers::seal(r.p(), None).unwrap();
    r.write("b.txt", "B\n");
    ops::stage_paths(r.p(), &["b.txt".into()]).unwrap();
    layers::seal(r.p(), None).unwrap();

    layers::commit_layer(r.p(), 1, "only b", &CommitOptions::default(), &Default::default()).unwrap();
    assert_eq!(r.head_blob("b.txt"), "B\n");
    assert_eq!(r.head_blob("a.txt"), "a\n");
    // a stays staged in the remaining layer.
    assert_eq!(r.index_blob("a.txt"), "A\n");
    let st = layers::state(r.p()).unwrap();
    assert_eq!(st.layers.len(), 1);
    assert_eq!(st.layers[0].files[0].path, "a.txt");

    // A normal commit of everything clears the layers.
    ops::commit(r.p(), "rest", &CommitOptions::default()).unwrap();
    assert!(!layers::state(r.p()).unwrap().active);
}

#[test]
fn stage_layers_unstage_file_from_layer_and_merge_down() {
    let r = Repo::new();
    r.write("a.txt", "a\n");
    r.write("b.txt", "b\n");
    r.write("c.txt", "c\n");
    r.commit_all("init");
    r.write("a.txt", "A\n");
    r.write("b.txt", "B\n");
    ops::stage_paths(r.p(), &["a.txt".into(), "b.txt".into()]).unwrap();
    layers::seal(r.p(), None).unwrap();
    r.write("c.txt", "C\n");
    ops::stage_paths(r.p(), &["c.txt".into()]).unwrap();
    layers::seal(r.p(), None).unwrap();

    layers::unstage_files(r.p(), 0, &["b.txt".into()]).unwrap();
    assert_eq!(r.index_blob("b.txt"), "b\n");
    assert_eq!(r.index_blob("a.txt"), "A\n");
    assert_eq!(r.index_blob("c.txt"), "C\n");

    layers::merge_down(r.p(), 1).unwrap();
    let st = layers::state(r.p()).unwrap();
    assert_eq!(st.layers.len(), 1);
    assert_eq!(st.layers[0].files.len(), 2);
}

fn conflict_setup(r: &Repo) {
    r.write("f.txt", "line1\nshared\nline3\n");
    r.commit_all("base");
    r.git(&["switch", "-q", "-c", "feature"]);
    r.write("f.txt", "line1\nfeature side\nline3\n");
    r.write("feature-only.txt", "feature\n");
    r.commit_all("feature change");
    r.git(&["switch", "-q", "main"]);
    r.write("f.txt", "line1\nmain side\nline3\n");
    r.commit_all("main change");
}

#[test]
fn merge_with_conflicts_resolve_and_confirm() {
    let r = Repo::new();
    conflict_setup(&r);
    let head_before = r.git(&["rev-parse", "HEAD"]);

    let out = ops::merge_start(r.p(), "feature", "no-ff").unwrap();
    assert_eq!(out.status, "conflicts");
    assert_eq!(out.conflicts, vec!["f.txt".to_string()]);
    // No commit was created yet.
    assert_eq!(r.git(&["rev-parse", "HEAD"]), head_before);
    let info = repo::info(r.p()).unwrap();
    assert_eq!(info.state.kind, "merge");
    assert_eq!(info.state.incoming_label.as_deref(), Some("feature"));

    let c = conflicts::info(r.p(), "f.txt").unwrap();
    assert_eq!(c.code, "UU");
    assert_eq!(c.conflict_count, 1);
    assert!(c.merged.contains("<<<<<<< ours\nmain side\n"));
    assert!(c.merged.contains(">>>>>>> theirs"));
    assert!(c.working_has_markers);

    // Confirm is refused while conflicts remain.
    assert!(ops::continue_op(r.p(), "merge", None).is_err());

    conflicts::save_resolution(r.p(), "f.txt", "line1\nmain side\nfeature side\nline3\n", true).unwrap();
    let done = ops::continue_op(r.p(), "merge", None).unwrap();
    assert_eq!(done.status, "done");
    let parents = r.git(&["rev-list", "--parents", "-n", "1", "HEAD"]);
    assert_eq!(parents.split_whitespace().count(), 3);
    assert_eq!(r.head_blob("f.txt"), "line1\nmain side\nfeature side\nline3\n");
    assert_eq!(repo::info(r.p()).unwrap().state.kind, "none");
}

#[test]
fn merge_abort_restores_everything() {
    let r = Repo::new();
    conflict_setup(&r);
    let head_before = r.git(&["rev-parse", "HEAD"]);
    ops::merge_start(r.p(), "feature", "no-ff").unwrap();
    ops::abort_op(r.p(), "merge").unwrap();
    assert_eq!(r.git(&["rev-parse", "HEAD"]), head_before);
    assert_eq!(r.read("f.txt"), "line1\nmain side\nline3\n");
    assert!(!r.p().join("feature-only.txt").exists());
    assert_eq!(repo::info(r.p()).unwrap().state.kind, "none");
}

#[test]
fn clean_merge_waits_for_confirmation() {
    let r = Repo::new();
    r.write("a.txt", "a\n");
    r.commit_all("base");
    r.git(&["switch", "-q", "-c", "feature"]);
    r.write("b.txt", "b\n");
    r.commit_all("feature");
    r.git(&["switch", "-q", "main"]);
    r.write("c.txt", "c\n");
    r.commit_all("main");
    let before = r.git(&["rev-parse", "HEAD"]);
    let out = ops::merge_start(r.p(), "feature", "no-ff").unwrap();
    assert_eq!(out.status, "pending");
    assert_eq!(r.git(&["rev-parse", "HEAD"]), before);
    let s = status::status(r.p()).unwrap();
    assert!(s.files.iter().any(|f| f.path == "b.txt" && f.index == "A"));
    ops::continue_op(r.p(), "merge", Some("Merge feature (reviewed)")).unwrap();
    assert_eq!(r.git(&["log", "-1", "--format=%s"]).trim(), "Merge feature (reviewed)");
}

#[test]
fn squash_merge_and_take_side() {
    let r = Repo::new();
    conflict_setup(&r);
    let out = ops::merge_start(r.p(), "feature", "squash").unwrap();
    assert_eq!(out.status, "conflicts");
    assert_eq!(repo::info(r.p()).unwrap().state.kind, "squash");
    conflicts::take_side(r.p(), "f.txt", "theirs").unwrap();
    assert_eq!(r.read("f.txt"), "line1\nfeature side\nline3\n");
    ops::continue_op(r.p(), "squash", Some("Squash feature")).unwrap();
    let parents = r.git(&["rev-list", "--parents", "-n", "1", "HEAD"]);
    assert_eq!(parents.split_whitespace().count(), 2);
    assert_eq!(repo::info(r.p()).unwrap().state.kind, "none");
}

#[test]
fn cherry_pick_conflict_then_continue() {
    let r = Repo::new();
    conflict_setup(&r);
    let feat = r.git(&["rev-parse", "feature"]).trim().to_string();
    let out = ops::cherry_pick(r.p(), &[feat], false).unwrap();
    assert_eq!(out.status, "conflicts");
    assert_eq!(repo::info(r.p()).unwrap().state.kind, "cherry-pick");
    conflicts::take_side(r.p(), "f.txt", "ours").unwrap();
    let done = ops::continue_op(r.p(), "cherry-pick", None).unwrap();
    assert_eq!(done.status, "done");
    assert!(r.p().join("feature-only.txt").exists());
}

#[test]
fn rewrite_reword_drop_squash_move_and_undo() {
    let r = Repo::new();
    r.write("a.txt", "1\n");
    r.commit_all("c1");
    r.write("b.txt", "2\n");
    let c2 = r.commit_all("c2");
    r.write("c.txt", "3\n");
    let _c3 = r.commit_all("c3");
    r.write("d.txt", "4\n");
    r.commit_all("c4");
    // Dirty worktree survives thanks to --autostash.
    r.write("a.txt", "dirty\n");

    ops::rewrite(r.p(), &RewriteAction::Reword { oid: c2.clone(), message: "second commit".into() }).unwrap();
    assert_eq!(r.git(&["log", "--format=%s"]).trim(), "c4\nc3\nsecond commit\nc1");
    assert_eq!(r.read("a.txt"), "dirty\n");

    let c3 = r.git(&["rev-parse", "HEAD~1"]).trim().to_string();
    let _ = c3.clone();
    ops::rewrite(r.p(), &RewriteAction::Drop { oids: vec![c3.clone()] }).unwrap();
    assert_eq!(r.git(&["log", "--format=%s"]).trim(), "c4\nsecond commit\nc1");
    assert!(!r.p().join("c.txt").exists());

    let head = r.git(&["rev-parse", "HEAD"]).trim().to_string();
    let prev = r.git(&["rev-parse", "HEAD~1"]).trim().to_string();
    ops::rewrite(r.p(), &RewriteAction::Squash { oids: vec![head, prev], message: "squashed".into() }).unwrap();
    assert_eq!(r.git(&["log", "--format=%s"]).trim(), "squashed\nc1");

    r.git(&["stash", "-q"]);
    r.write("e.txt", "5\n");
    r.commit_all("c5");
    let squashed = r.git(&["rev-parse", "HEAD~1"]).trim().to_string();
    ops::rewrite(r.p(), &RewriteAction::Move { oid: squashed, delta: 1 }).unwrap();
    assert_eq!(r.git(&["log", "--format=%s"]).trim(), "squashed\nc5\nc1");

    ops::rewrite(r.p(), &RewriteAction::Reword { oid: "HEAD".into(), message: "top".into() }).unwrap();
    assert_eq!(r.git(&["log", "-1", "--format=%s"]).trim(), "top");

    ops::undo_last_commit(r.p()).unwrap();
    assert_eq!(r.git(&["log", "--format=%s"]).trim(), "c5\nc1");
    let s = status::status(r.p()).unwrap();
    assert!(s.staged_count >= 2);
    let _ = c3;
}

#[test]
fn edit_commit_stops_rebase() {
    let r = Repo::new();
    r.write("a.txt", "1\n");
    let c1 = r.commit_all("c1");
    r.write("b.txt", "2\n");
    r.commit_all("c2");
    let out = ops::rewrite(r.p(), &RewriteAction::Edit { oid: c1 }).unwrap();
    assert_eq!(out.status, "stopped");
    assert_eq!(repo::info(r.p()).unwrap().state.kind, "rebase");
    r.write("a.txt", "1 amended\n");
    r.git(&["add", "a.txt"]);
    r.git(&["commit", "-q", "--amend", "--no-edit"]);
    let done = ops::continue_op(r.p(), "rebase", None).unwrap();
    assert_eq!(done.status, "done");
    assert_eq!(r.git(&["show", "HEAD~1:a.txt"]), "1 amended\n");
}

#[test]
fn graph_rows_and_search() {
    let r = Repo::new();
    r.write("a.txt", "1\n");
    r.commit_all("first");
    r.git(&["switch", "-q", "-c", "topic"]);
    r.write("b.txt", "2\n");
    r.commit_all("topic work");
    r.git(&["switch", "-q", "main"]);
    r.write("c.txt", "3\n");
    r.commit_all("main work");
    r.git(&["merge", "-q", "--no-ff", "-m", "merge topic", "topic"]);
    r.write("c.txt", "dirty\n");

    let g = graph::build(r.p(), None, true, 1000, false).unwrap();
    let fast = graph::build(r.p(), None, true, 1000, true).unwrap();
    assert_eq!(fast.rows.len(), g.rows.len());
    assert_eq!(g.rows.len(), 5);
    assert_eq!(g.rows[0].oid, graph::WORKTREE_OID);
    assert!(g.rows[1].is_head && g.rows[1].is_merge);
    assert!(g.rows[1].refs.iter().any(|l| l.name == "main" && l.kind == "head"));
    assert!(g.max_lanes >= 2);
    let hits = graph::search(r.p(), &g, "topic", graph::SearchMode::Quick).unwrap();
    assert!(hits.len() >= 2);
    let hits = graph::search(r.p(), &g, "b.txt", graph::SearchMode::Path).unwrap();
    assert_eq!(hits.len(), 1);
}

#[test]
fn stash_roundtrip_and_discard_backup() {
    let r = Repo::new();
    r.write("a.txt", "a\n");
    r.commit_all("init");
    r.write("a.txt", "changed\n");
    r.write("u.txt", "untracked\n");
    ops::stash_save(r.p(), "wip", true, false, &[]).unwrap();
    assert_eq!(r.read("a.txt"), "a\n");
    assert!(!r.p().join("u.txt").exists());
    ops::stash_apply(r.p(), 0, true).unwrap();
    assert_eq!(r.read("a.txt"), "changed\n");

    let backup = ops::discard_paths(r.p(), &["a.txt".into()], &["u.txt".into()]).unwrap();
    assert_eq!(r.read("a.txt"), "a\n");
    assert!(!r.p().join("u.txt").exists());
    assert_eq!(fs::read_to_string(Path::new(&backup).join("u.txt")).unwrap(), "untracked\n");
}

#[test]
fn branch_details_reports_fork_point_and_merge_state() {
    let r = Repo::new();
    r.write("a.txt", "1\n");
    let base = r.commit_all("base");
    r.git(&["switch", "-q", "-c", "topic"]);
    r.write("b.txt", "2\n");
    r.commit_all("topic one");
    r.write("c.txt", "3\n");
    let tip = r.commit_all("topic two");
    r.git(&["switch", "-q", "main"]);
    r.write("d.txt", "4\n");
    r.commit_all("main moves on");

    let d = revqora_lib::git::refs::branch_details(r.p(), "topic", "main").unwrap();
    assert_eq!(d.fork_point.as_deref(), Some(base.as_str()));
    assert_eq!(d.tip, tip);
    assert_eq!((d.ahead, d.behind), (2, 1));
    assert_eq!(d.first_subject.as_deref(), Some("topic one"));
    assert_eq!(d.last_subject, "topic two");
    assert!(!d.merged);

    r.git(&["merge", "-q", "--no-ff", "-m", "merge topic", "topic"]);
    let d = revqora_lib::git::refs::branch_details(r.p(), "topic", "main").unwrap();
    assert!(d.merged);
}

#[test]
fn partial_discard_of_untracked_and_partial_unstage_of_new_file() {
    let r = Repo::new();
    r.write("base.txt", "x\n");
    r.commit_all("init");

    // Discard one line of an untracked file.
    r.write("u.txt", "a\nb\nc\n");
    let d = diff::working_diff(r.p(), "u.txt", WorkSide::Unstaged, None, true, &opts()).unwrap();
    let sel = select_lines(&d, |k, t| k == "+" && t == "b");
    diff::apply_selection(r.p(), "u.txt", SelectionMode::Discard, &sel, &d.hash, None, true, &opts()).unwrap();
    assert_eq!(r.read("u.txt"), "a\nc\n");

    // Unstage one line of a newly added (staged) file.
    r.write("n.txt", "1\n2\n3\n");
    r.git(&["add", "n.txt"]);
    let s = diff::working_diff(r.p(), "n.txt", WorkSide::Staged, None, false, &opts()).unwrap();
    assert!(s.is_new);
    let sel = select_lines(&s, |k, t| k == "+" && t == "2");
    diff::apply_selection(r.p(), "n.txt", SelectionMode::Unstage, &sel, &s.hash, None, false, &opts()).unwrap();
    assert_eq!(r.index_blob("n.txt"), "1\n3\n");
    assert_eq!(r.read("n.txt"), "1\n2\n3\n");

    // Unstaging every line of the new file removes it from the index entirely.
    let s = diff::working_diff(r.p(), "n.txt", WorkSide::Staged, None, false, &opts()).unwrap();
    let sel = select_lines(&s, |k, _| k == "+");
    diff::apply_selection(r.p(), "n.txt", SelectionMode::Unstage, &sel, &s.hash, None, false, &opts()).unwrap();
    assert!(runner::exec(r.p(), ["ls-files", "--error-unmatch", "n.txt"]).unwrap().code != 0);

    // Stage part of a deletion.
    r.write("del.txt", "k1\nk2\nk3\n");
    r.commit_all("add del");
    fs::remove_file(r.p().join("del.txt")).unwrap();
    let d = diff::working_diff(r.p(), "del.txt", WorkSide::Unstaged, None, false, &opts()).unwrap();
    assert!(d.is_deleted);
    let sel = select_lines(&d, |k, t| k == "-" && t == "k2");
    diff::apply_selection(r.p(), "del.txt", SelectionMode::Stage, &sel, &d.hash, None, false, &opts()).unwrap();
    assert_eq!(r.index_blob("del.txt"), "k1\nk3\n");
}

#[test]
fn compare_blame_and_blob() {
    use revqora_lib::git::inspect::{self, BlobSpec};
    let r = Repo::new();
    r.write("a.txt", "one\ntwo\n");
    let base = r.commit_all("base");
    r.git(&["switch", "-q", "-c", "topic"]);
    r.write("a.txt", "one\nTWO\n");
    r.write("b.txt", "new\n");
    r.commit_all("topic change");
    r.git(&["switch", "-q", "main"]);
    r.write("c.txt", "main only\n");
    r.commit_all("main change");

    // Since branching: only the topic's own changes.
    let c = inspect::compare(r.p(), "main", "topic", true).unwrap();
    assert_eq!(c.merge_base.as_deref(), Some(base.as_str()));
    let mut files: Vec<&str> = c.files.iter().map(|f| f.path.as_str()).collect();
    files.sort();
    assert_eq!(files, vec!["a.txt", "b.txt"]);
    assert_eq!(c.ahead.len(), 1);
    assert_eq!(c.behind, 1);
    // Direct diff also shows main's file as removed.
    let d = inspect::compare(r.p(), "main", "topic", false).unwrap();
    assert!(d.files.iter().any(|f| f.path == "c.txt" && f.status == "D"));
    assert!(inspect::compare(r.p(), "main", "no-such-branch", true).is_err());

    r.git(&["switch", "-q", "topic"]);
    let b = inspect::blame(r.p(), "a.txt", None).unwrap();
    assert_eq!(b.lines.len(), 2);
    assert_eq!(b.commits[&b.lines[0].oid].summary, "base");
    assert_eq!(b.commits[&b.lines[1].oid].summary, "topic change");
    let at_base = inspect::blame(r.p(), "a.txt", Some(&base)).unwrap();
    assert!(at_base.lines.iter().all(|l| l.oid == base));

    let png: &[u8] = &[0x89, b'P', b'N', b'G', 0, 1, 2];
    std::fs::write(r.p().join("img.png"), png).unwrap();
    let w = inspect::blob(r.p(), &BlobSpec { rev: None, worktree: Some("img.png".into()) }).unwrap().unwrap();
    assert_eq!(w.mime, "image/png");
    assert_eq!(w.size, 7);
    r.commit_all("image");
    let h = inspect::blob(r.p(), &BlobSpec { rev: Some("HEAD:img.png".into()), worktree: None }).unwrap().unwrap();
    assert_eq!(h.base64, w.base64);
    assert!(inspect::blob(r.p(), &BlobSpec { rev: None, worktree: Some("../outside.png".into()) }).map(|b| b.is_none()).unwrap_or(true));
}

#[test]
fn interactive_rebase_reorders_rewords_squashes_and_drops() {
    use revqora_lib::git::ops::RebaseItem;
    let r = Repo::new();
    r.write("base.txt", "0\n");
    r.commit_all("base");
    for (f, m) in [("a.txt", "A"), ("b.txt", "B"), ("c.txt", "C"), ("d.txt", "D"), ("e.txt", "E")] {
        r.write(f, &format!("{m}\n"));
        r.commit_all(m);
    }
    let oldest = r.git(&["rev-parse", "HEAD~4"]).trim().to_string();
    let plan = ops::rebase_plan(r.p(), &oldest).unwrap();
    let subjects: Vec<&str> = plan.commits.iter().map(|c| c.subject.as_str()).collect();
    assert_eq!(subjects, vec!["A", "B", "C", "D", "E"]);
    let oid = |s: &str| plan.commits.iter().find(|c| c.subject == s).unwrap().oid.clone();
    let item = |s: &str, action: &str, message: Option<&str>| RebaseItem { oid: oid(s), action: action.into(), message: message.map(|m| m.into()) };
    // New order: C, A (+ squash D into A with a combined message), B reworded, E dropped.
    let items = vec![
        item("C", "pick", None),
        item("A", "pick", Some("A and D")),
        item("D", "squash", None),
        item("B", "reword", Some("B renamed")),
        item("E", "drop", None),
    ];
    let out = ops::interactive_rebase(r.p(), plan.base.as_deref(), &items).unwrap();
    assert_eq!(out.status, "done");
    assert_eq!(r.git(&["log", "--format=%s"]).trim(), "B renamed\nA and D\nC\nbase");
    assert!(r.p().join("d.txt").exists());
    assert!(!r.p().join("e.txt").exists());

    // A stale plan is refused.
    let err = ops::interactive_rebase(r.p(), plan.base.as_deref(), &items).unwrap_err();
    assert_eq!(err.kind, "stale");
    // Squashing the first commit is refused.
    let plan = ops::rebase_plan(r.p(), r.git(&["rev-parse", "HEAD~1"]).trim()).unwrap();
    let items: Vec<RebaseItem> = plan.commits.iter().map(|c| RebaseItem { oid: c.oid.clone(), action: "squash".into(), message: None }).collect();
    assert!(ops::interactive_rebase(r.p(), plan.base.as_deref(), &items).is_err());
}

#[test]
fn layer_conflicts_can_be_resolved_by_hand() {
    use revqora_lib::git::layers::{LayerOp, Resolutions};
    let r = Repo::new();
    r.write(
        "f.txt",
        "start
v1
end
",
    );
    r.commit_all("init");
    // Layer 1 changes line 2, layer 2 changes it again on top.
    r.write(
        "f.txt",
        "start
v2
end
",
    );
    ops::stage_paths(r.p(), &["f.txt".into()]).unwrap();
    layers::seal(r.p(), None).unwrap();
    r.write(
        "f.txt",
        "start
v3
end
",
    );
    ops::stage_paths(r.p(), &["f.txt".into()]).unwrap();
    layers::seal(r.p(), None).unwrap();

    let op = LayerOp::Unstage { index: 0 };
    let c = layers::preview(r.p(), &op, &Resolutions::new()).unwrap().expect("a conflict");
    assert_eq!(c.item, 1);
    assert_eq!(c.files.len(), 1);
    let f = &c.files[0];
    assert_eq!(f.path, "f.txt");
    assert_eq!(
        f.base.text,
        "start
v2
end
"
    );
    assert_eq!(
        f.ours.text,
        "start
v1
end
"
    );
    assert_eq!(
        f.theirs.text,
        "start
v3
end
"
    );
    assert!(f.merged.contains("<<<<<<<"));

    let mut res = Resolutions::new();
    res.insert(
        format!("{}:f.txt", c.item),
        "start
v3 without v2
end
"
        .into(),
    );
    assert!(layers::preview(r.p(), &op, &res).unwrap().is_none());
    layers::unstage(r.p(), 0, &res).unwrap();
    assert_eq!(
        r.index_blob("f.txt"),
        "start
v3 without v2
end
"
    );
    let st = layers::state(r.p()).unwrap();
    assert_eq!(st.layers.len(), 1);
    // The working tree is untouched.
    assert_eq!(
        r.read("f.txt"),
        "start
v3
end
"
    );
}
