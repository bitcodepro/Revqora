use super::*;
#[test]
fn symbol_history_finds_body_only_edits_and_pins_its_commit_anchor() {
    let d = tempfile::tempdir().unwrap();
    let r = d.path();
    runner::run(r, ["init", "-qb", "main"]).unwrap();
    for (k, v) in [("user.name", "Symbol history"), ("user.email", "symbol@example.invalid"), ("commit.gpgsign", "false"), ("core.hooksPath", ".git/hooks")] {
        runner::run(r, ["config", k, v]).unwrap();
    }
    let commit = |body: &str, message: &str| {
        std::fs::write(r.join("code.ts"), body).unwrap();
        runner::run(r, ["add", "."]).unwrap();
        runner::run(r, ["commit", "-qm", message]).unwrap();
    };
    commit("export function refreshToken(x: number) {\n return x;\n}\n", "Define token flow");
    commit("export function refreshToken(x: number) {\n return x + 1;\n}\n", "Change token body only");
    let literal = search(r, "refreshToken", Some("code.ts"), 0).unwrap();
    assert_eq!(literal.items.len(), 1);
    assert_eq!(literal.items[0].subject, "Define token flow");
    let old = symbol_history(r, "code.ts", "refreshToken", None, 0).unwrap();
    assert_eq!(old.unavailable, 0);
    assert_eq!(old.items.len(), 2);
    assert_eq!(old.items[0].subject, "Change token body only");
    commit("// comment only\nexport function refreshToken(x: number) {\n return x + 1;\n}\n", "Comment on token flow");
    let current = symbol_history(r, "code.ts", "refreshToken", None, 0).unwrap();
    assert_eq!(current.items.len(), 2);
    assert_eq!(current.scanned, 3);
    assert_ne!(current.anchor, old.anchor);
    let pinned = symbol_history(r, "code.ts", "refreshToken", Some(&old.anchor), 0).unwrap();
    assert_eq!(pinned.scanned, 2);
    assert_eq!(pinned.anchor, old.anchor);
    commit("function broken(", "Temporarily broken source");
    let partial = symbol_history(r, "code.ts", "refreshToken", None, 0).unwrap();
    assert_eq!(partial.unavailable, 1);
    assert!(!partial.notices.is_empty());
    assert_eq!(partial.items.len(), 2);
}
#[test]
fn json_uses_exact_numbers_paths_and_rejects_duplicate_keys() {
    assert!(compare_text("x.json", Some("// comment\n{\"x\":1}"), None).is_err());
    assert!(compare_text("x.json", Some("{} {}"), None).is_err());
    let d = compare_text("config.json", Some(r#"{"a/b":{"~key":9007199254740992},"same":1}"#), Some(r#"{"same":1,"a/b":{"~key":9007199254740993}}"#)).unwrap();
    assert_eq!(d.changes.len(), 1);
    assert_eq!(d.changes[0].key, "/a~1b/~0key");
    assert!(compare_text("x.json", Some(r#"{"x":1,"x":2}"#), None).is_err());
    assert!(compare_text("x.json", Some(r#"{"x":1,}"#), None).is_err());
    assert!(compare_text("x.json", Some(r#"{"x":1}"#), Some("{\n\"x\":1\n}")).unwrap().changes.is_empty());
    assert_eq!(compare_text("x.json", None, Some("null")).unwrap().changes[0].state, "added");
}
#[test]
fn csharp_and_typescript_parse_real_declarations_without_hiding_text_changes() {
    let d = compare_text(
        "Service.cs",
        Some("class Service { public int Run(int x) { return x; } public int Run(string x) { return 1; } }"),
        Some("class Service { public int Run(int x) { return x + 1; } public int Run(string x) { return 1; } }"),
    )
    .unwrap();
    assert_eq!(d.changes.iter().filter(|c| c.new.as_ref().unwrap().kind == "method_declaration").count(), 1);
    let d = compare_text("module.ts", Some("export function run(x: number) { return x; }"), Some("// comment\nexport function run(x: number) { return x; }"))
        .unwrap();
    assert!(d.changes.is_empty());
    let d = compare_text("module.ts", Some("const value = 'a b';"), Some("const value = 'ab';")).unwrap();
    assert!(!d.changes.is_empty());
    assert!(compare_text("component.tsx", Some("export const C = () => <b>Hi</b>;"), Some("export const C = () => <b>Bye</b>;"))
        .unwrap()
        .changes
        .iter()
        .any(|c| c.state == "changed"));
    assert!(compare_text("broken.ts", Some("function ("), None).is_err());
}

#[test]
fn inserted_declarations_do_not_mark_unchanged_peers_as_moved_and_asi_is_not_whitespace() {
    let d = compare_text(
        "x.ts",
        Some("function a(){ return 1; } function b(){ return 2; }"),
        Some("function added(){ return 0; } function a(){ return 1; } function b(){ return 2; }"),
    )
    .unwrap();
    assert_eq!(d.changes.len(), 1);
    assert_eq!(d.changes[0].state, "added");
    let d = compare_text("x.ts", Some("function a(){return 1;}"), Some("function a(){return\n1;}")).unwrap();
    assert!(d.changes.iter().any(|c| c.state == "changed"));
}
#[test]
fn source_limits_and_revision_options_fail_before_reading_outside_the_repository() {
    assert!(compare_text("big.ts", Some(&"x".repeat(LIMIT + 1)), None).is_err());
    let d = tempfile::tempdir().unwrap();
    assert!(read(d.path(), &BlobSpec { rev: Some("--batch".into()), worktree: None }).is_err());
    assert!(read(d.path(), &BlobSpec { rev: None, worktree: Some("../secret".into()) }).is_err());
}
#[test]
fn history_search_is_literal_and_does_not_write_the_index() {
    let d = tempfile::tempdir().unwrap();
    let r = d.path();
    runner::run(r, ["init", "-qb", "main"]).unwrap();
    for (k, v) in [("user.name", "Semantic fixture"), ("user.email", "semantic@example.invalid"), ("commit.gpgsign", "false"), ("core.hooksPath", ".git/hooks")]
    {
        runner::run(r, ["config", k, v]).unwrap();
    }
    std::fs::write(r.join("code.ts"), "const value = 0;\n").unwrap();
    runner::run(r, ["add", "."]).unwrap();
    runner::run(r, ["commit", "-qm", "base"]).unwrap();
    std::fs::write(r.join("code.ts"), "const value = call[0](x);\n").unwrap();
    runner::run(r, ["add", "."]).unwrap();
    runner::run(r, ["commit", "-qm", "change code"]).unwrap();
    let before = std::fs::read(r.join(".git/index")).unwrap();
    let result = crate::git::operations::access(r, false, |_, _| {}, || search(r, "call[0](x)", Some("code.ts"), 0)).unwrap();
    assert_eq!(result.items.len(), 1);
    assert_eq!(result.items[0].subject, "change code");
    assert!(search(r, "call[0](x)", Some("other.ts"), 0).unwrap().items.is_empty());
    assert!(search(r, "call0x", None, 0).unwrap().items.is_empty());
    assert_eq!(before, std::fs::read(r.join(".git/index")).unwrap());
}

#[test]
fn json_history_distinguishes_the_document_from_an_empty_property_pointer() {
    let d = tempfile::tempdir().unwrap();
    let r = d.path();
    runner::run(r, ["init", "-qb", "main"]).unwrap();
    for (k, v) in [("user.name", "JSON fixture"), ("user.email", "json@example.invalid"), ("commit.gpgsign", "false"), ("core.hooksPath", ".git/hooks")] {
        runner::run(r, ["config", k, v]).unwrap();
    }
    std::fs::write(r.join("config.json"), r#"{"":{"child":1},"other":2}"#).unwrap();
    runner::run(r, ["add", "."]).unwrap();
    runner::run(r, ["commit", "-qm", "JSON pointers"]).unwrap();
    let oid = runner::run(r, ["rev-parse", "HEAD"]).unwrap();
    let selected = selected_at(r, oid.trim(), "config.json", "/", &mut BTreeMap::new()).unwrap();
    assert_eq!(selected.keys().map(String::as_str).collect::<Vec<_>>(), ["/", "//child"]);
    let whole = selected_at(r, oid.trim(), "config.json", "$", &mut BTreeMap::new()).unwrap();
    assert!(whole.contains_key("") && whole.contains_key("/other"));
    let summary = compare_text("config.json", None, Some(r#"{"":1}"#)).unwrap();
    assert_ne!(summary.changes[0].new.as_ref().unwrap().name, summary.changes[1].new.as_ref().unwrap().name);
}
