//! Local syntax-aware summaries, always supplementary to the original text diff.
use super::{
    inspect::BlobSpec,
    runner::{self, GitError, GitResult},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::Read,
    path::Path,
    time::{Duration, Instant},
};
use tree_sitter::{Language, Node, ParseOptions, Parser};
const LIMIT: usize = 512 * 1024;
fn fail(s: impl Into<String>) -> GitError {
    GitError::new(s).kind("semantic-preview")
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Symbol {
    pub name: String,
    pub kind: String,
    pub line: usize,
    pub preview: String,
    fingerprint: String,
    ordinal: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub key: String,
    pub state: String,
    pub old: Option<Symbol>,
    pub new: Option<Symbol>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub language: String,
    pub changes: Vec<Change>,
    pub total: usize,
    pub notice: String,
}
fn clipped(s: &str) -> String {
    let mut end = s.len().min(2048);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    if end < s.len() {
        format!("{}…", &s[..end])
    } else {
        s.to_owned()
    }
}
fn fingerprint(s: &[u8]) -> String {
    format!("{:x}", Sha256::digest(s))
}
fn grammar(path: &str) -> GitResult<(Language, &'static str)> {
    Ok(match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "json" => (tree_sitter_json::LANGUAGE.into(), "JSON"),
        "cs" | "csx" => (tree_sitter_c_sharp::LANGUAGE.into(), "C#"),
        "ts" | "mts" | "cts" => (tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(), "TypeScript"),
        "tsx" => (tree_sitter_typescript::LANGUAGE_TSX.into(), "TSX"),
        _ => return Err(fail("Syntax summaries support C#, TypeScript, TSX and strict JSON.")),
    })
}
fn text<'a>(n: Node<'_>, source: &'a str) -> &'a str {
    &source[n.byte_range()]
}
fn tokens(node: Node<'_>, source: &str, depth: usize, out: &mut Sha256) -> GitResult<()> {
    if depth > 128 {
        return Err(fail("Syntax nesting exceeds the preview limit."));
    }
    if node.kind().contains("comment") {
        return Ok(());
    }
    out.update(node.kind().as_bytes());
    out.update([0]);
    if node.child_count() == 0 {
        out.update(text(node, source).as_bytes());
        out.update([0]);
    } else {
        let mut c = node.walk();
        for n in node.children(&mut c) {
            tokens(n, source, depth + 1, out)?;
        }
    }
    out.update([255]);
    Ok(())
}
fn syntax_hash(node: Node<'_>, source: &str) -> GitResult<String> {
    let mut hash = Sha256::new();
    tokens(node, source, 0, &mut hash)?;
    Ok(format!("{:x}", hash.finalize()))
}
fn symbol(node: Node<'_>, source: &str, name: String, ordinal: usize) -> GitResult<Symbol> {
    Ok(Symbol {
        name,
        kind: node.kind().into(),
        line: node.start_position().row + 1,
        preview: clipped(text(node, source)),
        fingerprint: syntax_hash(node, source)?,
        ordinal,
    })
}
fn code(node: Node<'_>, source: &str, scope: &str, depth: usize, seen: &mut usize, out: &mut BTreeMap<String, Symbol>) -> GitResult<()> {
    *seen += 1;
    if depth > 128 || *seen > 50_000 || out.len() > 2000 {
        return Err(fail("Source structure exceeds the preview limit."));
    }
    let kind = node.kind();
    let candidate = kind.ends_with("_declaration")
        || matches!(kind, "method_definition" | "method_signature" | "variable_declarator" | "public_field_definition" | "property_signature");
    let mut nested_scope = scope.to_owned();
    if candidate {
        if let Some(name) = node.child_by_field_name("name") {
            let name = text(name, source);
            if name.len() > 512 || scope.len() > 1024 {
                return Err(fail("Declaration names or nesting exceed the summary limit."));
            }
            let mut key = format!("{scope}/{kind}:{name}");
            if let Some(parameters) = node.child_by_field_name("parameters") {
                key.push_str(&format!(":{}", syntax_hash(parameters, source)?));
            }
            let base = key.clone();
            let mut duplicate = 1;
            while out.contains_key(&key) {
                duplicate += 1;
                key = format!("{base}#{duplicate}");
            }
            nested_scope = key.clone();
            let readable = scope.split('/').filter(|p| !p.is_empty()).map(|p| p.split(':').nth(1).unwrap_or(p)).collect::<Vec<_>>().join(".");
            let item = symbol(node, source, if readable.is_empty() { name.into() } else { format!("{readable}.{name}") }, out.len())?;
            out.insert(key, item);
        }
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        code(child, source, &nested_scope, depth + 1, seen, out)?;
    }
    Ok(())
}
fn json(node: Node<'_>, source: &str, path: &str, depth: usize, out: &mut BTreeMap<String, Symbol>) -> GitResult<()> {
    if depth > 64 || out.len() > 5000 || path.len() > 2048 {
        return Err(fail("JSON structure exceeds the preview limit."));
    }
    let kind = node.kind();
    if kind == "object" {
        let mut seen = BTreeSet::new();
        let mut c = node.walk();
        for pair in node.named_children(&mut c) {
            if pair.kind() != "pair" {
                return Err(fail("Only strict JSON is supported."));
            }
            let key = pair.child_by_field_name("key").ok_or_else(|| fail("Invalid JSON property."))?;
            let name: String = serde_json::from_str(text(key, source)).map_err(|_| fail("Invalid JSON property name."))?;
            if !seen.insert(name.clone()) {
                return Err(fail("Duplicate JSON keys are ambiguous; use the text diff."));
            }
            let pointer = format!("{path}/{}", name.replace('~', "~0").replace('/', "~1"));
            json(pair.child_by_field_name("value").ok_or_else(|| fail("Missing JSON value."))?, source, &pointer, depth + 1, out)?;
        }
    } else if kind == "array" {
        let mut c = node.walk();
        for (i, value) in node.named_children(&mut c).enumerate() {
            json(value, source, &format!("{path}/{i}"), depth + 1, out)?;
        }
    }
    let mut item = if matches!(kind, "object" | "array") {
        Symbol {
            name: if path.is_empty() { "$ (document)".into() } else { path.into() },
            kind: kind.into(),
            line: node.start_position().row + 1,
            preview: String::new(),
            fingerprint: String::new(),
            ordinal: 0,
        }
    } else {
        symbol(node, source, if path.is_empty() { "$ (document)".into() } else { path.into() }, 0)?
    };
    if matches!(kind, "object" | "array") {
        item.preview = format!("{kind} ({} members)", node.named_child_count());
        item.fingerprint = kind.into();
    } else if kind == "string" {
        let value: String = serde_json::from_str(text(node, source)).map_err(|_| fail("Invalid JSON string."))?;
        item.fingerprint = fingerprint(value.as_bytes());
    }
    out.insert(path.into(), item);
    Ok(())
}
fn snapshot(path: &str, source: Option<&str>) -> GitResult<(BTreeMap<String, Symbol>, String)> {
    let Some(source) = source else {
        return Ok((BTreeMap::new(), String::new()));
    };
    if source.len() > LIMIT || source.contains('\0') {
        return Err(fail("Syntax previews require UTF-8 text up to 512 KiB without NUL bytes."));
    }
    let (language, name) = grammar(path)?;
    if name == "JSON" {
        // Some parser grammars accept comments as extras. Validate one strict
        // JSON value without converting number tokens to floating point.
        serde_json::from_str::<serde::de::IgnoredAny>(source)
            .map_err(|_| fail("Only one strict JSON value is supported; comments and trailing values require the original text diff."))?;
    }
    let mut parser = Parser::new();
    parser.set_language(&language).map_err(|e| fail(e.to_string()))?;
    let deadline = Instant::now() + Duration::from_millis(500);
    let mut stop = |_: &tree_sitter::ParseState| if Instant::now() > deadline { std::ops::ControlFlow::Break(()) } else { std::ops::ControlFlow::Continue(()) };
    let tree = parser
        .parse_with_options(&mut |offset, _| &source.as_bytes()[offset..], None, Some(ParseOptions::new().progress_callback(&mut stop)))
        .ok_or_else(|| fail("Syntax parsing exceeded its time limit."))?;
    let node = tree.root_node();
    if node.has_error() {
        return Err(fail("The file has unsupported or incomplete syntax. Use the original text diff."));
    }
    let mut out = BTreeMap::new();
    if name == "JSON" {
        json(node.named_child(0).ok_or_else(|| fail("Empty JSON document."))?, source, "", 0, &mut out)?;
    } else {
        code(node, source, "", 0, &mut 0, &mut out)?;
    }
    Ok((out, syntax_hash(node, source)?))
}
pub fn compare_text(path: &str, old: Option<&str>, new: Option<&str>) -> GitResult<Comparison> {
    let (_, language) = grammar(path)?;
    let (a, ha) = snapshot(path, old)?;
    let (b, hb) = snapshot(path, new)?;
    let keys: BTreeSet<_> = a.keys().chain(b.keys()).cloned().collect();
    let common: Vec<_> = a.keys().filter(|k| b.contains_key(*k)).collect();
    let ranks = |m: &BTreeMap<String, Symbol>| {
        let mut ordered = common.clone();
        ordered.sort_by_key(|key| m[*key].ordinal);
        ordered.into_iter().enumerate().map(|(i, k)| (k.to_string(), i)).collect::<BTreeMap<_, _>>()
    };
    let old_rank = ranks(&a);
    let new_rank = ranks(&b);
    let mut changes = vec![];
    for key in keys {
        let old = a.get(&key);
        let new = b.get(&key);
        let state = match (old, new) {
            (None, Some(_)) => "added",
            (Some(_), None) => "removed",
            (Some(a), Some(b)) if a.fingerprint != b.fingerprint => "changed",
            (Some(_), Some(_)) if language != "JSON" && old_rank.get(&key) != new_rank.get(&key) => "moved",
            _ => continue,
        };
        changes.push(Change { key, state: state.into(), old: old.cloned(), new: new.cloned() });
    }
    let mut notice="Syntax grouping is an aid, not a proof of equivalent behavior. Comments, formatting, file modes and unclassified edits remain visible in the original text diff below. Previews are limited to 2 KiB per side.".to_owned();
    if changes.is_empty() && ha != hb && language != "JSON" {
        notice.push_str(" Syntax changed outside the indexed declarations; inspect the text diff.");
    }
    let total = changes.len();
    if total > 500 {
        changes.truncate(500);
        notice.push_str(" Only the first 500 structural changes are listed.");
    }
    Ok(Comparison { language: language.into(), changes, total, notice })
}
fn valid_path(p: &str) -> bool {
    !p.is_empty() && p.len() <= 4096 && !p.contains('\0') && !Path::new(p).is_absolute() && !p.split(['/', '\\']).any(|c| c == "..")
}
fn read(root: &Path, spec: &BlobSpec) -> GitResult<String> {
    let mut bytes = vec![];
    if let Some(p) = &spec.worktree {
        if !valid_path(p) {
            return Err(fail("Choose a repository-relative path."));
        }
        let path = root.join(p).canonicalize()?;
        if !path.starts_with(root.canonicalize()?) {
            return Err(fail("The file is outside this working copy."));
        }
        File::open(path)?.take(LIMIT as u64 + 1).read_to_end(&mut bytes)?;
    } else if let Some(spec) = &spec.rev {
        let (revision, p) = spec.split_once(':').ok_or_else(|| fail("Select an exact commit blob or the index."))?;
        if !valid_path(p) || !revision.is_empty() && !(matches!(revision.len(), 40 | 64) && revision.bytes().all(|b| b.is_ascii_hexdigit())) {
            return Err(fail("Select an exact commit blob or the index."));
        }
        let size = runner::run(root, ["cat-file", "-s", spec])?.trim().parse::<usize>().map_err(|_| fail("Unknown blob size."))?;
        if size > LIMIT {
            return Err(fail("Syntax previews are limited to 512 KiB per file."));
        }
        let result = runner::exec(root, ["cat-file", "blob", spec])?;
        if !result.ok() {
            return Err(runner::to_error("read syntax source", &result));
        }
        bytes = result.stdout;
    } else {
        return Err(fail("Missing syntax source."));
    }
    if bytes.len() > LIMIT {
        return Err(fail("Syntax previews are limited to 512 KiB per file."));
    }
    String::from_utf8(bytes).map_err(|_| fail("Syntax previews require UTF-8 text."))
}
pub fn compare(root: &Path, path: &str, old: Option<BlobSpec>, new: Option<BlobSpec>) -> GitResult<Comparison> {
    let old = old.as_ref().map(|s| read(root, s)).transpose()?;
    let new = new.as_ref().map(|s| read(root, s)).transpose()?;
    compare_text(path, old.as_deref(), new.as_deref())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub oid: String,
    pub author: String,
    pub time: i64,
    pub subject: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub items: Vec<HistoryEntry>,
    pub next_offset: Option<usize>,
    pub capped: bool,
}
fn history_rows(raw: &str) -> GitResult<Vec<HistoryEntry>> {
    let fields: Vec<_> = raw.split('\0').collect();
    let mut items = vec![];
    for row in fields.chunks(4) {
        if row.len() != 4 {
            continue;
        }
        let oid = row[0].trim();
        if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(fail("Invalid history response."));
        }
        items.push(HistoryEntry {
            oid: oid.into(),
            author: clipped(row[1]),
            time: row[2].parse().map_err(|_| fail("Invalid history timestamp."))?,
            subject: clipped(row[3]),
        });
    }
    Ok(items)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolHistoryPage {
    pub items: Vec<HistoryEntry>,
    pub next_offset: Option<usize>,
    pub anchor: String,
    pub scanned: usize,
    pub unavailable: usize,
    pub notices: Vec<String>,
    pub capped: bool,
}
type SelectedSymbols = BTreeMap<String, String>;
fn selected_at(root: &Path, revision: &str, path: &str, query: &str, cache: &mut BTreeMap<String, SelectedSymbols>) -> GitResult<SelectedSymbols> {
    let raw = runner::run(root, ["--literal-pathspecs", "ls-tree", "-z", revision, "--", path])?;
    let rows: Vec<_> = raw.split('\0').filter(|s| !s.is_empty()).collect();
    if rows.is_empty() {
        return Ok(BTreeMap::new());
    }
    if rows.len() != 1 {
        return Err(fail("Choose one complete file path for symbol history."));
    }
    let (header, actual) = rows[0].split_once('\t').ok_or_else(|| fail("Invalid file tree response."))?;
    let fields: Vec<_> = header.split_whitespace().collect();
    if fields.len() != 3 || actual != path || fields[1] != "blob" || !matches!(fields[0], "100644" | "100755") {
        return Err(fail("Symbol history requires a regular source file."));
    }
    if let Some(found) = cache.get(fields[2]) {
        return Ok(found.clone());
    }
    let content = read(root, &BlobSpec { rev: Some(format!("{revision}:{path}")), worktree: None })?;
    let (units, _) = snapshot(path, Some(&content))?;
    let json = path.to_ascii_lowercase().ends_with(".json");
    let selected: SelectedSymbols = units
        .into_iter()
        .filter(|(key, s)| {
            if json {
                query == "$" || *key == query || key.starts_with(&format!("{query}/"))
            } else {
                s.name == query || s.name.rsplit('.').next() == Some(query)
            }
        })
        .map(|(key, s)| (key, s.fingerprint))
        .collect();
    if cache.len() >= 8 {
        if let Some(first) = cache.keys().next().cloned() {
            cache.remove(&first);
        }
    }
    cache.insert(fields[2].into(), selected.clone());
    Ok(selected)
}
pub fn symbol_history(root: &Path, path: &str, query: &str, anchor: Option<&str>, offset: usize) -> GitResult<SymbolHistoryPage> {
    if !valid_path(path)
        || query.trim().is_empty()
        || query.len() > 256
        || query.chars().any(char::is_control)
        || offset > 5000
        || anchor.is_some_and(|s| !matches!(s.len(), 40 | 64) || !s.bytes().all(|c| c.is_ascii_hexdigit()))
    {
        return Err(fail("Choose a source file, a symbol/JSON pointer of 1–256 bytes and an exact history anchor."));
    }
    grammar(path)?;
    let anchor = runner::run(root, ["rev-parse", "--verify", "--end-of-options", &format!("{}^{{commit}}", anchor.unwrap_or("HEAD"))])?.trim().to_owned();
    let raw = runner::run(
        root,
        [
            "--literal-pathspecs",
            "log",
            "--first-parent",
            "--full-history",
            "--no-ext-diff",
            "--no-textconv",
            "--format=%H%x00%an%x00%at%x00%s%x00",
            "--max-count=26",
            &format!("--skip={offset}"),
            &anchor,
            "--",
            path,
        ],
    )?;
    let candidates = history_rows(&raw)?;
    let candidates_have_more = candidates.len() > 25;
    let next_offset = (candidates_have_more && offset < 5000).then_some(offset + 25);
    let mut cache = BTreeMap::new();
    let mut items = vec![];
    let mut unavailable = 0;
    let mut scanned = 0;
    let mut notices = vec![];
    for row in candidates.into_iter().take(25) {
        scanned += 1;
        let parsed = (|| {
            let parents = runner::run(root, ["rev-list", "--parents", "-n", "1", &row.oid])?;
            let old = match parents.split_whitespace().nth(1) {
                Some(parent) => selected_at(root, parent, path, query, &mut cache)?,
                None => BTreeMap::new(),
            };
            let new = selected_at(root, &row.oid, path, query, &mut cache)?;
            Ok::<_, GitError>(old != new)
        })();
        match parsed {
            Ok(true) => items.push(row),
            Ok(false) => {}
            Err(error) => {
                unavailable += 1;
                let message = format!("{}: {}", &row.oid[..12], clipped(&error.message));
                if notices.len() < 3 && !notices.contains(&message) {
                    notices.push(message);
                }
            }
        }
    }
    Ok(SymbolHistoryPage { items, next_offset, anchor, scanned, unavailable, notices, capped: candidates_have_more && offset >= 5000 })
}
pub fn search(root: &Path, query: &str, path: Option<&str>, offset: usize) -> GitResult<HistoryPage> {
    if query.trim().is_empty() || query.len() > 256 || query.chars().any(char::is_control) || offset > 5000 || path.is_some_and(|p| !valid_path(p)) {
        return Err(fail("Enter 1–256 bytes of literal code text and an optional repository-relative path."));
    }
    let escaped = query.chars().fold(String::new(), |mut s, c| {
        if ".[]\\*^$()+?{|}".contains(c) {
            s.push('\\');
        }
        s.push(c);
        s
    });
    let mut args = vec![
        "--literal-pathspecs".into(),
        "log".into(),
        "--branches".into(),
        "--remotes".into(),
        "--tags".into(),
        "HEAD".into(),
        "--root".into(),
        "--diff-merges=first-parent".into(),
        "--no-ext-diff".into(),
        "--no-textconv".into(),
        "--no-decorate".into(),
        "--format=%H%x00%an%x00%at%x00%s%x00".into(),
        format!("--skip={offset}"),
        "--max-count=51".into(),
        format!("-G{escaped}"),
        "--".into(),
    ];
    if let Some(p) = path {
        args.push(p.into());
    }
    let raw = runner::run(root, args)?;
    let mut items = history_rows(&raw)?;
    let capped = items.len() > 50 && offset >= 5000;
    let next_offset = (items.len() > 50 && offset < 5000).then_some(offset + 50);
    items.truncate(50);
    Ok(HistoryPage { items, next_offset, capped })
}

#[cfg(test)]
mod tests;
