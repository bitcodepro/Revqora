//! Stage layers: several independent "staging areas" stacked on top of HEAD.
//!
//! Git has a single index. Revqora models layers as a chain of hidden commits
//! (`refs/worktree/revqora/layers`): each layer commit holds the *cumulative* tree
//! (HEAD + layers 1..k). The real index always equals the top layer plus the
//! "open" layer — whatever was staged since the last layer was sealed.
//!
//! Removing or reordering a layer replays the remaining layer diffs with
//! `git merge-tree`, so independent layers can be unstaged/discarded/committed
//! in any order; dependent ones are reported as conflicts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::diff::EMPTY_TREE;
use super::repo;
use super::runner::{self, GitError, GitResult};

pub const LAYER_REF: &str = "refs/worktree/revqora/layers";
const MARK: &str = "revqora-layer";
const IDENT: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "Revqora"),
    ("GIT_AUTHOR_EMAIL", "layers@revqora.local"),
    ("GIT_COMMITTER_NAME", "Revqora"),
    ("GIT_COMMITTER_EMAIL", "layers@revqora.local"),
];

/// (parent tree, cumulative tree) of one layer diff.
type Item = (String, String);

#[derive(Debug, Clone)]
struct LayerRec {
    tree: String,
    name: String,
    created: i64,
}

#[derive(Debug, Clone)]
struct Chain {
    base_commit: Option<String>,
    base_tree: String,
    layers: Vec<LayerRec>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerView {
    /// 0-based position from the bottom (closest to HEAD).
    pub index: usize,
    pub name: String,
    pub created: i64,
    pub files: Vec<LayerFile>,
    /// Tree before / after this layer (for diffs).
    pub from_tree: String,
    pub to_tree: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LayersState {
    pub active: bool,
    pub layers: Vec<LayerView>,
    /// Files staged since the last layer was sealed.
    pub open_files: Vec<LayerFile>,
    /// Commit to diff the open layer against (top layer), when layers exist.
    pub staged_base: Option<String>,
    pub note: Option<String>,
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn head_commit(repo: &Path) -> Option<String> {
    runner::exec(repo, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]).ok().filter(|o| o.ok()).map(|o| o.text().trim().to_string())
}

fn tree_of(repo: &Path, commit: Option<&str>) -> GitResult<String> {
    match commit {
        Some(c) => Ok(runner::run(repo, ["rev-parse", &format!("{c}^{{tree}}")])?.trim().to_string()),
        None => Ok(EMPTY_TREE.to_string()),
    }
}

fn index_tree(repo: &Path) -> GitResult<String> {
    let out = runner::exec(repo, ["write-tree"])?;
    if !out.ok() {
        return Err(GitError::new("Resolve the merge conflicts before working with stage layers.").kind("conflict"));
    }
    Ok(out.text().trim().to_string())
}

fn read_chain(repo: &Path) -> GitResult<Option<Chain>> {
    let top = runner::exec(repo, ["rev-parse", "-q", "--verify", LAYER_REF])?;
    if !top.ok() {
        return Ok(None);
    }
    let mut cur = Some(top.text().trim().to_string());
    let mut layers = Vec::new();
    let mut base_commit = None;
    let mut guard = 0;
    while let Some(c) = cur.take() {
        guard += 1;
        if guard > 200 {
            break;
        }
        let raw = runner::run(repo, ["cat-file", "commit", &c])?;
        let (headers, message) = raw.split_once("\n\n").unwrap_or((raw.as_str(), ""));
        if !message.starts_with(MARK) {
            base_commit = Some(c);
            break;
        }
        let mut tree = String::new();
        let mut parent = None;
        let mut created = 0;
        for h in headers.lines() {
            if let Some(t) = h.strip_prefix("tree ") {
                tree = t.to_string();
            } else if let Some(p) = h.strip_prefix("parent ") {
                parent = Some(p.to_string());
            } else if let Some(a) = h.strip_prefix("author ") {
                created = a.rsplit(' ').nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
            }
        }
        let name = message.lines().find_map(|l| l.strip_prefix("name: ")).unwrap_or("").to_string();
        layers.push(LayerRec { tree, name, created });
        cur = parent;
    }
    layers.reverse();
    let base_tree = tree_of(repo, base_commit.as_deref())?;
    Ok(Some(Chain { base_commit, base_tree, layers }))
}

fn write_chain(repo: &Path, base_commit: Option<&str>, layers: &[LayerRec]) -> GitResult<()> {
    if layers.is_empty() {
        let _ = runner::exec(repo, ["update-ref", "-d", LAYER_REF]);
        return Ok(());
    }
    let mut parent = base_commit.map(|s| s.to_string());
    for l in layers {
        let msg = format!("{MARK}\n\nname: {}\n", l.name);
        let mut args = vec!["commit-tree".to_string(), l.tree.clone()];
        if let Some(p) = &parent {
            args.push("-p".into());
            args.push(p.clone());
        }
        args.push("-m".into());
        args.push(msg);
        let date = format!("{} +0000", if l.created > 0 { l.created } else { now() });
        let mut env: Vec<(&str, &str)> = IDENT.to_vec();
        env.push(("GIT_AUTHOR_DATE", &date));
        env.push(("GIT_COMMITTER_DATE", &date));
        let oid = runner::run_env(repo, &args, &env, None)?.trim().to_string();
        parent = Some(oid);
    }
    runner::run(repo, ["update-ref", LAYER_REF, parent.as_deref().unwrap()])?;
    Ok(())
}

fn temp_commit(repo: &Path, tree: &str) -> GitResult<String> {
    let date = "1000000000 +0000";
    let mut env: Vec<(&str, &str)> = IDENT.to_vec();
    env.push(("GIT_AUTHOR_DATE", date));
    env.push(("GIT_COMMITTER_DATE", date));
    Ok(runner::run_env(repo, ["commit-tree", tree, "-m", "revqora-temp"], &env, None)?.trim().to_string())
}

/// Three-way merge of trees. Ok(Err((tree with conflict markers, paths))) = conflicts.
fn merge3(repo: &Path, base: &str, ours: &str, theirs: &str) -> GitResult<Result<String, (String, Vec<String>)>> {
    if ours == base || ours == theirs {
        return Ok(Ok(theirs.to_string()));
    }
    if theirs == base {
        return Ok(Ok(ours.to_string()));
    }
    if !runner::version_at_least(2, 40) {
        return Err(GitError::new("Reordering stage layers needs Git 2.40 or newer."));
    }
    let (cb, co, ct) = (temp_commit(repo, base)?, temp_commit(repo, ours)?, temp_commit(repo, theirs)?);
    let out = runner::exec(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", &format!("--merge-base={cb}"), &co, &ct])?;
    let text = out.text();
    let mut lines = text.lines();
    let tree = lines.next().unwrap_or("").trim().to_string();
    match out.code {
        0 => Ok(Ok(tree)),
        1 => {
            let mut files: Vec<String> = lines.take_while(|l| !l.is_empty()).map(|l| l.to_string()).collect();
            files.dedup();
            Ok(Err((tree, files)))
        }
        _ => Err(runner::to_error("git merge-tree", &out)),
    }
}

fn diff_files(repo: &Path, from: &str, to: &str) -> GitResult<Vec<LayerFile>> {
    if from == to {
        return Ok(Vec::new());
    }
    let raw = runner::run(repo, ["diff-tree", "-r", "-z", "--name-status", "--find-renames", from, to])?;
    let mut out = Vec::new();
    let mut it = raw.split('\0').filter(|s| !s.is_empty());
    while let Some(st) = it.next() {
        let code = st.chars().next().unwrap_or('M').to_string();
        if code == "R" || code == "C" {
            let old = it.next().unwrap_or("").to_string();
            let new = it.next().unwrap_or("").to_string();
            out.push(LayerFile { path: new, old_path: Some(old), status: code });
        } else if let Some(p) = it.next() {
            out.push(LayerFile { path: p.to_string(), old_path: None, status: code });
        }
    }
    Ok(out)
}

fn index_files(repo: &Path, against_tree: &str) -> GitResult<Vec<LayerFile>> {
    let raw = runner::run(repo, ["diff-index", "--cached", "-z", "--name-status", "--find-renames", against_tree])?;
    let mut out = Vec::new();
    let mut it = raw.split('\0').filter(|s| !s.is_empty());
    while let Some(st) = it.next() {
        let code = st.chars().next().unwrap_or('M').to_string();
        if code == "R" || code == "C" {
            let old = it.next().unwrap_or("").to_string();
            let new = it.next().unwrap_or("").to_string();
            out.push(LayerFile { path: new, old_path: Some(old), status: code });
        } else if let Some(p) = it.next() {
            out.push(LayerFile { path: p.to_string(), old_path: None, status: code });
        }
    }
    Ok(out)
}

fn drop_empty(base_tree: &str, layers: Vec<LayerRec>) -> Vec<LayerRec> {
    let mut prev = base_tree.to_string();
    let mut out = Vec::new();
    for l in layers {
        if l.tree != prev {
            prev = l.tree.clone();
            out.push(l);
        }
    }
    out
}

/// Hand-made resolutions for layer conflicts, keyed by `"{item}:{path}"` (item = original
/// layer index, the open layer being the last one).
pub type Resolutions = HashMap<String, String>;

/// Where a replay stopped: position in the order, conflicting paths and the three trees.
struct Stop {
    pos: usize,
    files: Vec<String>,
    base: String,
    ours: String,
    theirs: String,
}

/// Replaces paths in `tree` with resolved contents and returns the new tree.
fn write_resolved(repo: &Path, tree: &str, theirs: &str, files: &[(String, String)]) -> GitResult<String> {
    let tmp = temp_index(repo)?;
    let tmp_s = tmp.to_string_lossy().into_owned();
    let env = [("GIT_INDEX_FILE", tmp_s.as_str())];
    let res = (|| -> GitResult<String> {
        runner::run_env(repo, ["read-tree", tree], &env, None)?;
        let mut info = String::new();
        for (path, content) in files {
            let oid = runner::run_env(repo, ["hash-object", "-w", "--stdin"], &[], Some(content.as_bytes()))?.trim().to_string();
            // Keep the file mode of the layer's version (e.g. executable scripts).
            let mode = runner::run(repo, ["ls-tree", theirs, "--", path])
                .ok()
                .and_then(|l| l.split_whitespace().next().map(|m| m.to_string()))
                .unwrap_or_else(|| "100644".into());
            info.push_str(&format!("{mode} {oid}\t{path}\n"));
        }
        runner::run_env(repo, ["update-index", "--index-info"], &env, Some(info.as_bytes()))?;
        Ok(runner::run_env(repo, ["write-tree"], &env, None)?.trim().to_string())
    })();
    let _ = std::fs::remove_file(&tmp);
    res
}

/// Re-applies layer diffs in a new order on top of `base_tree`. `ids[i]` is the original
/// item index of `items[i]`, used to look up resolutions.
fn replay(repo: &Path, base_tree: &str, items: &[Item], ids: &[usize], res: &Resolutions) -> GitResult<Result<Vec<String>, Stop>> {
    let mut prev = base_tree.to_string();
    let mut out = Vec::with_capacity(items.len());
    for (i, (parent, tree)) in items.iter().enumerate() {
        let t = match merge3(repo, parent, &prev, tree)? {
            Ok(t) => t,
            Err((marked, files)) => {
                let resolved: Option<Vec<(String, String)>> =
                    files.iter().map(|f| res.get(&format!("{}:{f}", ids[i])).map(|c| (f.clone(), c.clone()))).collect();
                match resolved {
                    Some(r) => write_resolved(repo, &marked, tree, &r)?,
                    None => return Ok(Err(Stop { pos: i, files, base: parent.clone(), ours: prev, theirs: tree.clone() })),
                }
            }
        };
        prev = t.clone();
        out.push(t);
    }
    Ok(Ok(out))
}

/// Keeps the layer chain consistent with HEAD after commits, checkouts or resets.
fn reconcile(repo: &Path) -> GitResult<(Option<Chain>, Option<String>)> {
    let Some(chain) = read_chain(repo)? else { return Ok((None, None)) };
    let head = head_commit(repo);
    if chain.base_commit == head {
        // Layers wiped from outside (e.g. `git reset`): index went back to the base.
        // Read-only check: `write-tree` would rewrite the index and race with `status`.
        let index_is_base = match &chain.base_commit {
            Some(b) => runner::exec(repo, ["diff-index", "--cached", "--quiet", b.as_str(), "--"])?.code == 0,
            None => runner::run(repo, ["ls-files", "--cached"])?.trim().is_empty(),
        };
        if index_is_base && !chain.layers.is_empty() {
            write_chain(repo, None, &[])?;
            return Ok((None, Some("The index was reset outside Revqora, so stage layers were cleared.".into())));
        }
        return Ok((Some(chain), None));
    }
    let head_tree = tree_of(repo, head.as_deref())?;
    // Bottom layers were committed: drop them.
    if let Some(j) = chain.layers.iter().rposition(|l| l.tree == head_tree) {
        let rest: Vec<LayerRec> = chain.layers[j + 1..].to_vec();
        write_chain(repo, head.as_deref(), &rest)?;
        return Ok((read_chain(repo)?, None));
    }
    // HEAD moved elsewhere: try to carry the layers over.
    let mut items = Vec::new();
    let mut parent = chain.base_tree.clone();
    for l in &chain.layers {
        items.push((parent.clone(), l.tree.clone()));
        parent = l.tree.clone();
    }
    let ids: Vec<usize> = (0..items.len()).collect();
    match replay(repo, &head_tree, &items, &ids, &Resolutions::new())? {
        Ok(trees) => {
            let layers: Vec<LayerRec> = chain.layers.iter().zip(trees).map(|(l, t)| LayerRec { tree: t, name: l.name.clone(), created: l.created }).collect();
            let layers = drop_empty(&head_tree, layers);
            write_chain(repo, head.as_deref(), &layers)?;
            Ok((read_chain(repo)?, None))
        }
        Err(_) => {
            write_chain(repo, None, &[])?;
            Ok((None, Some("HEAD moved and the stage layers no longer applied cleanly, so they were merged into one staged set.".into())))
        }
    }
}

pub fn state(repo: &Path) -> GitResult<LayersState> {
    let (chain, note) = reconcile(repo)?;
    let Some(chain) = chain else {
        return Ok(LayersState { note, ..Default::default() });
    };
    let mut views = Vec::new();
    let mut prev = chain.base_tree.clone();
    for (i, l) in chain.layers.iter().enumerate() {
        views.push(LayerView {
            index: i,
            name: if l.name.is_empty() { format!("Layer {}", i + 1) } else { l.name.clone() },
            created: l.created,
            files: diff_files(repo, &prev, &l.tree)?,
            from_tree: prev.clone(),
            to_tree: l.tree.clone(),
        });
        prev = l.tree.clone();
    }
    let top = runner::run(repo, ["rev-parse", LAYER_REF])?.trim().to_string();
    let open_files = index_files(repo, &top)?;
    Ok(LayersState { active: !views.is_empty(), layers: views, open_files, staged_base: Some(top), note })
}

/// The commit that "staged" diffs should be computed against (top layer or HEAD).
pub fn staged_base(repo: &Path) -> Option<String> {
    runner::exec(repo, ["rev-parse", "-q", "--verify", LAYER_REF]).ok().filter(|o| o.ok()).map(|o| o.text().trim().to_string())
}

fn load(repo: &Path) -> GitResult<Chain> {
    let (chain, _) = reconcile(repo)?;
    match chain {
        Some(c) => Ok(c),
        None => {
            let head = head_commit(repo);
            Ok(Chain { base_tree: tree_of(repo, head.as_deref())?, base_commit: head, layers: Vec::new() })
        }
    }
}

/// Seals everything currently staged (beyond existing layers) into a new layer.
pub fn seal(repo: &Path, name: Option<&str>) -> GitResult<()> {
    let chain = load(repo)?;
    let idx = index_tree(repo)?;
    let top = chain.layers.last().map(|l| l.tree.clone()).unwrap_or_else(|| chain.base_tree.clone());
    if idx == top {
        return Err(GitError::new("Nothing new is staged. Stage some changes first, then seal them into a layer."));
    }
    let mut layers = chain.layers.clone();
    let n = layers.len() + 1;
    layers.push(LayerRec {
        tree: idx,
        name: name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| format!("Layer {n}")),
        created: now(),
    });
    write_chain(repo, chain.base_commit.as_deref(), &layers)
}

/// All layers plus the open layer as (parent tree, cumulative tree, rec) items.
fn items_with_open(repo: &Path, chain: &Chain) -> GitResult<(Vec<Item>, Vec<LayerRec>)> {
    let mut items = Vec::new();
    let mut recs = Vec::new();
    let mut parent = chain.base_tree.clone();
    for l in &chain.layers {
        items.push((parent.clone(), l.tree.clone()));
        recs.push(l.clone());
        parent = l.tree.clone();
    }
    let idx = index_tree(repo)?;
    items.push((parent, idx.clone()));
    recs.push(LayerRec { tree: idx, name: "__open__".into(), created: 0 });
    Ok((items, recs))
}

fn set_index(repo: &Path, tree: &str) -> GitResult<()> {
    runner::run(repo, ["read-tree", tree])?;
    let _ = runner::exec(repo, ["update-index", "-q", "--refresh"]);
    Ok(())
}

/// Applies a new order of items (indices into items_with_open); the open layer must stay last if kept.
fn apply_order(repo: &Path, chain: &Chain, order: &[usize], res: &Resolutions) -> GitResult<()> {
    let (items, recs) = items_with_open(repo, chain)?;
    let picked: Vec<(String, String)> = order.iter().map(|&i| items[i].clone()).collect();
    match replay(repo, &chain.base_tree, &picked, order, res)? {
        Ok(trees) => {
            let open_idx = items.len() - 1;
            let mut sealed = Vec::new();
            let mut index_tree_new = chain.base_tree.clone();
            for (k, &i) in order.iter().enumerate() {
                index_tree_new = trees[k].clone();
                if i != open_idx {
                    sealed.push(LayerRec { tree: trees[k].clone(), name: recs[i].name.clone(), created: recs[i].created });
                }
            }
            // If the open layer was dropped the index equals the last sealed tree.
            let sealed = drop_empty(&chain.base_tree, sealed);
            write_chain(repo, chain.base_commit.as_deref(), &sealed)?;
            set_index(repo, &index_tree_new)
        }
        Err(stop) => {
            let label = item_label(order[stop.pos], items.len());
            Err(GitError::new(format!("{label} depends on the changes being removed or moved ({} file(s) conflict).", stop.files.len()))
                .kind("layer-conflict")
                .details(stop.files))
        }
    }
}

fn item_label(i: usize, count: usize) -> String {
    if i == count - 1 {
        "Changes staged after the last layer".to_string()
    } else {
        format!("Layer {}", i + 1)
    }
}

fn check_index(chain: &Chain, k: usize) -> GitResult<()> {
    if k > chain.layers.len() {
        return Err(GitError::new("That stage layer no longer exists. Refresh and try again.").kind("stale"));
    }
    Ok(())
}

/// Unstages a layer (k == number of layers means the open layer), keeping the others.
pub fn unstage(repo: &Path, k: usize, res: &Resolutions) -> GitResult<()> {
    let chain = load(repo)?;
    let order = order_for(&chain, &LayerOp::Unstage { index: k })?;
    apply_order(repo, &chain, &order, res)
}

/// Moves a layer up (+1, away from HEAD) or down (-1).
pub fn move_layer(repo: &Path, k: usize, delta: i32, res: &Resolutions) -> GitResult<()> {
    let chain = load(repo)?;
    let order = order_for(&chain, &LayerOp::Move { index: k, delta })?;
    apply_order(repo, &chain, &order, res)
}

/// Merges layer k into the layer below it (k ≥ 1). For the open layer this un-seals the top layer.
pub fn merge_down(repo: &Path, k: usize) -> GitResult<()> {
    let chain = load(repo)?;
    check_index(&chain, k)?;
    if k == 0 {
        return Err(GitError::new("The bottom layer has nothing below it."));
    }
    let mut layers = chain.layers.clone();
    // Cumulative trees: dropping the boundary below k merges the two diffs.
    let keep_name = layers[k - 1].name.clone();
    let created = layers[k - 1].created;
    layers.remove(k - 1);
    if k - 1 < layers.len() {
        layers[k - 1].name = keep_name;
        layers[k - 1].created = created;
    }
    write_chain(repo, chain.base_commit.as_deref(), &layers)
}

pub fn rename(repo: &Path, k: usize, name: &str) -> GitResult<()> {
    let chain = load(repo)?;
    if k >= chain.layers.len() {
        return Err(GitError::new("Only sealed layers can be renamed."));
    }
    let mut layers = chain.layers.clone();
    layers[k].name = name.trim().to_string();
    write_chain(repo, chain.base_commit.as_deref(), &layers)
}

/// Forgets the layer structure; everything stays staged as a single set.
pub fn flatten(repo: &Path) -> GitResult<()> {
    write_chain(repo, None, &[])
}

/// Unstages a layer AND removes its changes from the working tree (files are backed up first).
pub fn discard(repo: &Path, k: usize) -> GitResult<String> {
    let chain = load(repo)?;
    check_index(&chain, k)?;
    let (items, _) = items_with_open(repo, &chain)?;
    let (from, to) = items[k].clone();
    if from == to {
        return Err(GitError::new("The layer is empty."));
    }
    let files: Vec<String> = diff_files(repo, &from, &to)?.into_iter().flat_map(|f| std::iter::once(f.path).chain(f.old_path)).collect();
    let patch = runner::run_bytes(repo, ["diff", "--binary", "--no-color", "--no-ext-diff", &from, &to])?;
    let check = runner::exec_full(repo, ["apply", "-R", "--check", "-"], &[], Some(&patch))?;
    if !check.ok() {
        return Err(GitError::new(
            "The working tree changed in the same places after this layer was staged, so it cannot be removed automatically. Unstage it instead.",
        )
        .kind("layer-conflict")
        .details(files));
    }
    let backup = super::ops::backup_files(repo, &files)?;
    unstage(repo, k, &Resolutions::new())?;
    runner::run_env(repo, ["apply", "-R", "-"], &[], Some(&patch))?;
    Ok(backup.to_string_lossy().into_owned())
}

fn temp_index(repo: &Path) -> GitResult<PathBuf> {
    let dir = repo::git_dir(repo)?.join("revqora");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("index-{}", std::process::id())))
}

/// Removes some files from layer k (back to the state below it), re-applying the layers above.
pub fn unstage_files(repo: &Path, k: usize, paths: &[String]) -> GitResult<()> {
    let chain = load(repo)?;
    check_index(&chain, k)?;
    let (items, recs) = items_with_open(repo, &chain)?;
    let (from, to) = items[k].clone();
    let tmp = temp_index(repo)?;
    let tmp_s = tmp.to_string_lossy().into_owned();
    let env = [("GIT_INDEX_FILE", tmp_s.as_str())];
    let result = (|| -> GitResult<String> {
        runner::run_env(repo, ["read-tree", &to], &env, None)?;
        let mut rm = vec!["rm".to_string(), "--cached".into(), "-r".into(), "-q".into(), "--ignore-unmatch".into(), "--".into()];
        rm.extend(paths.iter().cloned());
        runner::run_env(repo, &rm, &env, None)?;
        let mut ls = vec!["ls-tree".to_string(), "-r".into(), "-z".into(), from.clone(), "--".into()];
        ls.extend(paths.iter().cloned());
        let entries = runner::run(repo, &ls)?;
        let mut info = String::new();
        for e in runner::split_nul(&entries) {
            // "<mode> <type> <oid>\t<path>"
            if let Some((meta, p)) = e.split_once('\t') {
                let f: Vec<&str> = meta.split(' ').collect();
                if f.len() == 3 {
                    info.push_str(&format!("{} {}\t{}\n", f[0], f[2], p));
                }
            }
        }
        if !info.is_empty() {
            runner::run_env(repo, ["update-index", "--index-info"], &env, Some(info.as_bytes()))?;
        }
        Ok(runner::run_env(repo, ["write-tree"], &env, None)?.trim().to_string())
    })();
    let _ = std::fs::remove_file(&tmp);
    let new_tree = result?;
    // Replay layers above k on top of the modified layer.
    let mut trees: Vec<String> = items.iter().map(|(_, t)| t.clone()).collect();
    trees[k] = new_tree;
    for j in k + 1..items.len() {
        match merge3(repo, &items[j].0, &trees[j - 1], &items[j].1)? {
            Ok(t) => trees[j] = t,
            Err((_, files)) => {
                return Err(GitError::new(format!("Layer {} depends on these changes.", j + 1)).kind("layer-conflict").details(files));
            }
        }
    }
    let n = items.len() - 1;
    let sealed: Vec<LayerRec> = (0..n).map(|i| LayerRec { tree: trees[i].clone(), name: recs[i].name.clone(), created: recs[i].created }).collect();
    let sealed = drop_empty(&chain.base_tree, sealed);
    write_chain(repo, chain.base_commit.as_deref(), &sealed)?;
    set_index(repo, &trees[n])
}

/// Commits layers 0..=k (bottom first) as a normal commit, leaving the others staged.
pub fn commit_through(repo: &Path, k: usize, message: &str, opts: &super::ops::CommitOptions) -> GitResult<String> {
    let chain = load(repo)?;
    if k >= chain.layers.len() {
        return Err(GitError::new("Only sealed layers can be committed separately."));
    }
    if message.trim().is_empty() {
        return Err(GitError::new("Commit message is empty."));
    }
    let tree = chain.layers[k].tree.clone();
    let tmp = temp_index(repo)?;
    let tmp_s = tmp.to_string_lossy().into_owned();
    let env = [("GIT_INDEX_FILE", tmp_s.as_str())];
    let msg_file = repo::git_dir(repo)?.join("revqora").join("LAYER_COMMIT_MSG");
    std::fs::write(&msg_file, message)?;
    let res = (|| -> GitResult<()> {
        runner::run_env(repo, ["read-tree", &tree], &env, None)?;
        let mut args = vec!["commit".to_string(), "--cleanup=strip".into(), "-F".into(), msg_file.to_string_lossy().into_owned()];
        if opts.no_verify {
            args.push("--no-verify".into());
        }
        if opts.sign_off {
            args.push("--signoff".into());
        }
        runner::run_env(repo, &args, &env, None)?;
        Ok(())
    })();
    let _ = std::fs::remove_file(&tmp);
    let _ = std::fs::remove_file(&msg_file);
    res?;
    // HEAD tree now equals layer k: reconcile drops the committed layers.
    reconcile(repo)?;
    let _ = runner::exec(repo, ["update-index", "-q", "--refresh"]);
    Ok(head_commit(repo).unwrap_or_default())
}

/// Commits a single layer that is not at the bottom by first moving it there.
pub fn commit_layer(repo: &Path, k: usize, message: &str, opts: &super::ops::CommitOptions, res: &Resolutions) -> GitResult<String> {
    let chain = load(repo)?;
    if k >= chain.layers.len() {
        return Err(GitError::new("Only sealed layers can be committed separately."));
    }
    if k > 0 {
        let order = order_for(&chain, &LayerOp::CommitLayer { index: k })?;
        apply_order(repo, &chain, &order, res)?;
    }
    commit_through(repo, 0, message, opts)
}

/// A layer operation that replays the other layers (and can therefore conflict).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", tag = "op")]
pub enum LayerOp {
    Unstage { index: usize },
    Move { index: usize, delta: i32 },
    CommitLayer { index: usize },
}

/// The replay order (indices into layers + open layer) an operation needs.
fn order_for(chain: &Chain, op: &LayerOp) -> GitResult<Vec<usize>> {
    let n = chain.layers.len();
    match *op {
        LayerOp::Unstage { index } => {
            check_index(chain, index)?;
            Ok((0..=n).filter(|&i| i != index).collect())
        }
        LayerOp::Move { index, delta } => {
            if index >= n {
                return Err(GitError::new("Only sealed layers can be moved."));
            }
            let target = index as i64 + delta as i64;
            if target < 0 || target >= n as i64 {
                return Err(GitError::new("The layer cannot move further."));
            }
            let mut order: Vec<usize> = (0..n).collect();
            order.swap(index, target as usize);
            order.push(n);
            Ok(order)
        }
        LayerOp::CommitLayer { index } => {
            if index >= n {
                return Err(GitError::new("Only sealed layers can be committed separately."));
            }
            let mut order: Vec<usize> = vec![index];
            order.extend((0..n).filter(|&i| i != index));
            order.push(n);
            Ok(order)
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerConflict {
    /// Original index of the layer whose changes no longer apply (key prefix for resolutions).
    pub item: usize,
    pub label: String,
    pub files: Vec<super::conflicts::ConflictInfo>,
}

fn side_at(repo: &Path, tree: &str, path: &str) -> GitResult<(super::conflicts::ConflictSide, Vec<u8>)> {
    let out = runner::exec(repo, ["cat-file", "blob", &format!("{tree}:{path}")])?;
    if !out.ok() {
        return Ok((super::conflicts::ConflictSide { exists: false, binary: false, text: String::new(), oid: None }, Vec::new()));
    }
    let binary = out.stdout.iter().take(8000).any(|b| *b == 0);
    let text = if binary { String::new() } else { String::from_utf8_lossy(&out.stdout).into_owned() };
    Ok((super::conflicts::ConflictSide { exists: true, binary, text, oid: None }, out.stdout))
}

/// Dry-runs an operation with the given resolutions and returns the first unresolved conflict.
pub fn preview(repo: &Path, op: &LayerOp, res: &Resolutions) -> GitResult<Option<LayerConflict>> {
    let chain = load(repo)?;
    let order = order_for(&chain, op)?;
    let (items, _) = items_with_open(repo, &chain)?;
    let picked: Vec<Item> = order.iter().map(|&i| items[i].clone()).collect();
    let stop = match replay(repo, &chain.base_tree, &picked, &order, res)? {
        Ok(_) => return Ok(None),
        Err(s) => s,
    };
    let item = order[stop.pos];
    let label = item_label(item, items.len());
    let mut files = Vec::new();
    for path in &stop.files {
        let (base, base_raw) = side_at(repo, &stop.base, path)?;
        let (ours, ours_raw) = side_at(repo, &stop.ours, path)?;
        let (theirs, theirs_raw) = side_at(repo, &stop.theirs, path)?;
        let textual = ours.exists && theirs.exists && !ours.binary && !theirs.binary && !base.binary;
        let (merged, count) = if textual { super::conflicts::merge_file(&ours_raw, &base_raw, &theirs_raw)? } else { (String::new(), 1) };
        let code = match (base.exists, ours.exists, theirs.exists) {
            (false, true, true) => "AA",
            (true, false, true) => "DU",
            (true, true, false) => "UD",
            _ => "UU",
        };
        let crlf = [&ours_raw, &theirs_raw].iter().any(|d| d.windows(2).any(|w| w == b"\r\n"));
        files.push(super::conflicts::ConflictInfo {
            path: path.clone(),
            code: code.into(),
            base,
            ours,
            theirs,
            merged,
            conflict_count: count,
            working: None,
            working_has_markers: false,
            ours_label: "other layers".into(),
            theirs_label: label.clone(),
            eol_crlf: crlf,
        });
    }
    Ok(Some(LayerConflict { item, label, files }))
}
