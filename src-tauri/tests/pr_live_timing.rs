//! Live PR timing against a real repository: REVQORA_LIVE_PR_REPO=<path> cargo test --test pr_live_timing -- --ignored --nocapture

use std::path::PathBuf;
use std::time::Instant;

use revqora_lib::git::pr_center;

#[test]
#[ignore]
fn live_pr_center_timings() {
    let Some(repo) = std::env::var_os("REVQORA_LIVE_PR_REPO").map(PathBuf::from) else { return };
    let time = |label: &str, f: &mut dyn FnMut() -> String| {
        let t = Instant::now();
        let out = f();
        println!("{label:<28} {:>6} ms  {out}", t.elapsed().as_millis());
    };
    for round in 0..2 {
        println!("round {round}");
        let mut page = None;
        time("page(all)", &mut || match pr_center::page(&repo, "all", None) {
            Ok(p) => {
                let s = format!("{} items", p.items.len());
                page = Some(p);
                s
            }
            Err(e) => format!("error {e:?}"),
        });
        let Some(page) = page else { return };
        let connection = page.forge.connection_revision.clone().unwrap();
        for pull in page.items.iter().take(2) {
            let n = pull.number;
            let mut revision = String::new();
            time(&format!("detail #{n}"), &mut || match pr_center::detail(&repo, n, &connection) {
                Ok(d) => {
                    revision = d.revision.clone();
                    d.pull.state
                }
                Err(e) => format!("error {e:?}"),
            });
            time(&format!("checks #{n}"), &mut || match pr_center::checks(&repo, n, &connection, Some(&revision)) {
                Ok(c) => format!("{} checks", c.checks.len()),
                Err(e) => format!("error {e:?}"),
            });
            time(&format!("files #{n}"), &mut || match pr_center::files(&repo, n, &connection, Some(&revision), 0) {
                Ok(f) => format!("{} files", f.items.len()),
                Err(e) => format!("error {e:?}"),
            });
        }
    }
}
