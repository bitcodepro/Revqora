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

fn states(d: &Comparison) -> Vec<(String, String)> {
    d.changes.iter().map(|c| (c.new.as_ref().or(c.old.as_ref()).unwrap().name.clone(), c.state.clone())).collect()
}
fn names(path: &str, source: &str) -> Vec<(String, String)> {
    let mut out: Vec<_> = snapshot(path, Some(source)).unwrap().0.into_values().map(|s| (s.name, s.kind)).collect();
    out.sort();
    out
}
fn has(list: &[(String, String)], name: &str, state: &str) -> bool {
    list.iter().any(|(n, s)| n == name && s == state)
}
#[test]
fn rust_indexes_items_impls_traits_and_modules() {
    let base = "mod net {\n pub struct Point { x: i32 }\n pub enum Shape { Dot, Line(i32) }\n pub trait Area { fn area(&self) -> i32; }\n impl Point {\n  pub fn new(x: i32) -> Self { Self { x } }\n  pub fn len(&self) -> i32 { self.x }\n }\n impl std::fmt::Debug for Point {\n  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { Ok(()) }\n }\n}\nfn helper() -> i32 { 1 }\n";
    let found = names("lib.rs", base);
    for (name, kind) in [
        ("net", "mod_item"),
        ("net.Point", "struct_item"),
        ("net.Point.x", "field_declaration"),
        ("net.Shape", "enum_item"),
        ("net.Shape.Line", "enum_variant"),
        ("net.Area", "trait_item"),
        ("net.Area.area", "function_signature_item"),
        ("net.Point", "impl_item"),
        ("net.Point.new", "function_item"),
        ("net.Point as std.fmt.Debug.fmt", "function_item"),
        ("helper", "function_item"),
    ] {
        assert!(found.contains(&(name.into(), kind.into())), "{name} {kind} missing from {found:?}");
    }
    let edited = base.replace("Self { x } }", "Self { x: x + 1 } }").replace("fn helper() -> i32 { 1 }", "fn added() {}");
    let d = states(&compare_text("lib.rs", Some(base), Some(&edited)).unwrap());
    assert!(has(&d, "net.Point.new", "changed") && has(&d, "added", "added") && has(&d, "helper", "removed"), "{d:?}");
    assert!(!has(&d, "net.Point.len", "changed"));
    let swapped = base.replace(
        "  pub fn new(x: i32) -> Self { Self { x } }\n  pub fn len(&self) -> i32 { self.x }\n",
        "  pub fn len(&self) -> i32 { self.x }\n  pub fn new(x: i32) -> Self { Self { x } }\n",
    );
    let d = states(&compare_text("lib.rs", Some(base), Some(&swapped)).unwrap());
    assert!(has(&d, "net.Point.len", "moved") || has(&d, "net.Point.new", "moved"), "{d:?}");
    assert!(compare_text("lib.rs", Some(base), Some(&format!("// note\n{base}"))).unwrap().changes.is_empty());
    assert!(compare_text("broken.rs", Some("fn broken("), None).is_err());
}
#[test]
fn python_indexes_classes_methods_and_nested_functions() {
    let base = "class Service:\n    def run(self, x):\n        return x\n\n    def stop(self):\n        def inner():\n            return 1\n        return inner()\n\n@cache\ndef helper(a):\n    return a\n";
    let found = names("svc.py", base);
    for (name, kind) in [
        ("Service", "class_definition"),
        ("Service.run", "function_definition"),
        ("Service.stop.inner", "function_definition"),
        ("helper", "function_definition"),
    ] {
        assert!(found.contains(&(name.into(), kind.into())), "{name} missing from {found:?}");
    }
    let edited = base.replace("return x\n", "return x + 1\n").replace("def helper(a):\n    return a\n", "def added():\n    pass\n");
    let d = states(&compare_text("svc.py", Some(base), Some(&edited)).unwrap());
    assert!(has(&d, "Service.run", "changed") && has(&d, "added", "added") && has(&d, "helper", "removed"), "{d:?}");
    assert!(!d.iter().any(|(n, _)| n == "Service.stop"));
    let moved = "@cache\ndef helper(a):\n    return a\n\nclass Service:\n    def run(self, x):\n        return x\n\n    def stop(self):\n        def inner():\n            return 1\n        return inner()\n";
    assert!(states(&compare_text("svc.pyi", Some(base), Some(moved)).unwrap()).iter().any(|(_, s)| s == "moved"));
    assert!(compare_text("svc.py", Some(base), Some(&format!("# note\n{base}"))).unwrap().changes.is_empty());
    assert!(compare_text("broken.py", Some("def broken(:\n"), None).is_err());
}
#[test]
fn go_indexes_types_receivers_and_interfaces() {
    let base = "package geo\n\ntype Point struct {\n\tX int\n}\n\ntype Shape interface {\n\tArea() int\n}\n\nfunc (p *Point) Area() int { return p.X }\n\nfunc (l List[T]) Len() int { return 0 }\n\nfunc Helper(a int) int { return a }\n";
    let found = names("geo.go", base);
    for (name, kind) in [
        ("Point", "type_spec"),
        ("Point.X", "field_declaration"),
        ("Shape", "type_spec"),
        ("Shape.Area", "method_elem"),
        ("Point.Area", "method_declaration"),
        ("List.Len", "method_declaration"),
        ("Helper", "function_declaration"),
    ] {
        assert!(found.contains(&(name.into(), kind.into())), "{name} {kind} missing from {found:?}");
    }
    assert!(!found.iter().any(|(_, k)| k == "parameter_declaration"), "{found:?}");
    let edited = base.replace("return p.X", "return p.X * 2").replace("func Helper(a int) int { return a }", "func Added() {}");
    let d = states(&compare_text("geo.go", Some(base), Some(&edited)).unwrap());
    assert!(has(&d, "Point.Area", "changed") && has(&d, "Added", "added") && has(&d, "Helper", "removed"), "{d:?}");
    assert!(!has(&d, "List.Len", "changed"));
    let moved = base.replace("func Helper(a int) int { return a }\n", "").replace("package geo\n", "package geo\n\nfunc Helper(a int) int { return a }\n");
    assert!(has(&states(&compare_text("geo.go", Some(base), Some(&moved)).unwrap()), "Helper", "moved"));
    assert!(compare_text("geo.go", Some(base), Some(&format!("// note\n{base}"))).unwrap().changes.is_empty());
    assert!(compare_text("broken.go", Some("package x\nfunc broken("), None).is_err());
}
#[test]
fn java_indexes_classes_overloads_and_nested_types() {
    let base = "package app;\nclass Service {\n  private int count = 0;\n  Service() {}\n  int run(int x) { return x; }\n  int run(String x) { return 1; }\n  enum Mode { FAST, SLOW }\n  interface Hook { void call(); }\n  static class Inner { void go() {} }\n}\n";
    let found = names("Service.java", base);
    for (name, kind) in [
        ("Service", "class_declaration"),
        ("Service.count", "variable_declarator"),
        ("Service.Service", "constructor_declaration"),
        ("Service.Mode", "enum_declaration"),
        ("Service.Mode.FAST", "enum_constant"),
        ("Service.Hook.call", "method_declaration"),
        ("Service.Inner.go", "method_declaration"),
    ] {
        assert!(found.contains(&(name.into(), kind.into())), "{name} {kind} missing from {found:?}");
    }
    assert_eq!(found.iter().filter(|(n, _)| n == "Service.run").count(), 2);
    let edited = base.replace("return x; }", "return x + 1; }").replace("void go() {}", "void go() {}\n    void added() {}");
    let d = compare_text("Service.java", Some(base), Some(&edited)).unwrap();
    assert_eq!(d.changes.iter().filter(|c| c.state == "changed" && c.new.as_ref().unwrap().kind == "method_declaration").count(), 1);
    assert!(has(&states(&d), "Service.Inner.added", "added"));
    let removed = states(&compare_text("Service.java", Some(base), Some(&base.replace("  int run(String x) { return 1; }\n", ""))).unwrap());
    assert!(has(&removed, "Service.run", "removed"), "{removed:?}");
    assert!(compare_text("Service.java", Some(base), Some(&format!("// note\n{base}"))).unwrap().changes.is_empty());
    assert!(compare_text("Broken.java", Some("class Broken { void x( }"), None).is_err());
}
#[test]
fn new_languages_support_symbol_history_and_degrade_on_broken_revisions() {
    let d = tempfile::tempdir().unwrap();
    let r = d.path();
    runner::run(r, ["init", "-qb", "main"]).unwrap();
    for (k, v) in [("user.name", "Symbol history"), ("user.email", "symbol@example.invalid"), ("commit.gpgsign", "false"), ("core.hooksPath", ".git/hooks")] {
        runner::run(r, ["config", k, v]).unwrap();
    }
    for (file, v1, v2, query) in [
        ("lib.rs", "struct P;\nimpl P { fn run(&self) -> i32 { 1 } }\n", "struct P;\nimpl P { fn run(&self) -> i32 { 2 } }\n", "P.run"),
        ("app.py", "class P:\n    def run(self):\n        return 1\n", "class P:\n    def run(self):\n        return 2\n", "P.run"),
        (
            "main.go",
            "package m\ntype P struct{}\nfunc (p P) Run() int { return 1 }\n",
            "package m\ntype P struct{}\nfunc (p P) Run() int { return 2 }\n",
            "P.Run",
        ),
        ("P.java", "class P { int run() { return 1; } }\n", "class P { int run() { return 2; } }\n", "P.run"),
    ] {
        for (body, message) in [(v1, "define"), (v2, "body only"), ("broken (", "broken")] {
            std::fs::write(r.join(file), body).unwrap();
            runner::run(r, ["add", "."]).unwrap();
            runner::run(r, ["commit", "-qm", &format!("{file} {message}")]).unwrap();
        }
        let page = symbol_history(r, file, query, None, 0).unwrap();
        assert_eq!(page.unavailable, 1, "{file}");
        assert_eq!(page.items.iter().map(|i| i.subject.as_str()).collect::<Vec<_>>(), [format!("{file} body only"), format!("{file} define")], "{file}");
    }
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
