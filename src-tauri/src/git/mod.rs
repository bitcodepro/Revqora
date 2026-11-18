pub mod agents;
pub mod branch_cleanup;
pub mod branch_deletion;
pub mod branch_protection;
pub mod branch_review;
pub mod commit;
pub mod config_cache;
pub mod conflicts;
pub mod connection;
pub mod connection_check;
pub mod diff;
pub mod external_tools;
pub mod extras;
pub mod forge;
pub mod forge_accounts;
#[cfg(test)]
pub(crate) mod forge_test_http;
pub mod graph;
pub mod ignore;
pub mod inspect;
pub mod layers;
pub mod line_history;
pub mod locate;
pub mod maint;
pub mod misc_tools;
pub mod more;
pub mod operations;
pub mod ops;
pub mod optimize;
pub mod pr_center;
pub mod pr_merge;
pub mod pr_reviews;
pub(super) mod pull_guard;
pub mod recovery;
pub mod refs;
pub mod repo;
pub mod repository_import;
pub mod runner;
pub mod sparse;
pub mod stage_timings;
pub mod status;
pub mod storage;
pub mod submodule_log;
pub mod tracking;
pub mod watcher;

pub mod file_editor;
pub mod partial_stash;
pub mod remote_rename;
mod text_encoding;
pub mod workspace_files;

pub mod rebase_studio;
pub mod validation;

pub mod branch_manager;
pub mod branch_origin;
pub mod branch_switch;
pub mod history;
pub mod hooks;

pub mod worktree_manager;

pub mod workflows;

pub(super) mod session_lease;

pub(super) mod atomic_file;

pub mod semantic;

pub mod stacks;
