//! Bounded complete check snapshots; partial pages are never presented as green.
use super::*;
pub(super) fn bitbucket(f: &ForgeInfo, sha: &str, mut get: impl FnMut(&str) -> GitResult<Value>) -> GitResult<Vec<forge::Check>> {
    let cloud = f.kind == "bitbucket";
    let first = if cloud {
        format!("/repositories/{}/commit/{}/statuses?pagelen=100", forge::project_path(&f.project), forge::enc(sha))
    } else {
        format!("/rest/build-status/1.0/commits/{sha}?limit=100")
    };
    let expected = url::Url::parse(&format!("{}{}", f.api, first)).map_err(|_| error("Invalid CI API URL."))?;
    let base = url::Url::parse(&f.api).map_err(|_| error("Invalid API base."))?;
    let mut path = first;
    let mut out = vec![];
    let mut visited = std::collections::BTreeSet::new();
    let mut start = 0;
    for _ in 0..50 {
        if !visited.insert(path.clone()) {
            return Err(error("CI status pagination repeated a page."));
        }
        let v = get(&path)?;
        for row in rows(&v, "/values")? {
            let name = text(row, "/name");
            out.push(check(if name.is_empty() { text(row, "/key") } else { name }, &text(row, "/state"), text(row, "/url")));
        }
        if out.len() > 5000 {
            return Err(error("CI status count exceeds the complete preview limit."));
        }
        if cloud {
            let Some(next) = v.get("next").filter(|v| !v.is_null()) else { return Ok(out) };
            let u = url::Url::parse(next.as_str().ok_or_else(|| error("Invalid next CI status page."))?).map_err(|_| error("Invalid CI pagination URL."))?;
            if u.origin() != expected.origin() || u.path() != expected.path() || !u.username().is_empty() || u.password().is_some() || u.fragment().is_some() {
                return Err(error("CI pagination leaves the reviewed repository or API origin."));
            }
            path = format!(
                "{}{}",
                u.path().strip_prefix(base.path().trim_end_matches('/')).ok_or_else(|| error("Invalid CI path."))?,
                u.query().map(|q| format!("?{q}")).unwrap_or_default()
            );
        } else {
            match v.get("isLastPage").and_then(Value::as_bool) {
                Some(true) => return Ok(out),
                Some(false) => {}
                None => return Err(error("Bitbucket omitted CI pagination completion.")),
            }
            let next =
                v.get("nextPageStart").and_then(Value::as_u64).filter(|n| *n > start).ok_or_else(|| error("Bitbucket CI pagination did not advance."))?;
            start = next;
            path = format!("/rest/build-status/1.0/commits/{sha}?limit=100&start={start}");
        }
    }
    Err(error("CI status pages exceed the complete preview limit."))
}
fn state(s: &str) -> String {
    match s.to_ascii_lowercase().as_str() {
        "success" | "successful" | "passed" | "succeeded" => "success",
        "failure" | "failed" | "error" | "timed_out" | "action_required" => "failure",
        "neutral" | "notapplicable" => "neutral",
        "skipped" => "skipped",
        "cancelled" | "canceled" | "stopped" => "cancelled",
        _ => "pending",
    }
    .into()
}
pub(super) fn status(s: &str) -> String {
    state(s)
}
fn check(name: String, status: &str, url: String) -> forge::Check {
    forge::Check { name, state: state(status), url: (!url.is_empty()).then_some(url) }
}
fn next_link(f: &ForgeInfo, current: &str, header: &str) -> GitResult<Option<String>> {
    let expected = url::Url::parse(&format!("{}{}", f.api, current)).map_err(|_| error("Invalid current CI path."))?;
    let base = url::Url::parse(&f.api).map_err(|_| error("Invalid API URL."))?;
    let mut next = None;
    for part in header.split(',') {
        let (uri, params) = part.trim().split_once(';').ok_or_else(|| error("Malformed CI pagination header."))?;
        if !params.split(';').filter_map(|p| p.trim().strip_prefix("rel=")).any(|p| p.trim_matches('"').split_whitespace().any(|r| r == "next")) {
            continue;
        }
        if next.is_some() {
            return Err(error("Ambiguous next CI page."));
        }
        let uri = uri.trim().strip_prefix('<').and_then(|p| p.strip_suffix('>')).ok_or_else(|| error("Invalid CI pagination link."))?;
        let u = url::Url::parse(uri).map_err(|_| error("Invalid CI pagination link URL."))?;
        if u.origin() != expected.origin() || u.path() != expected.path() || !u.username().is_empty() || u.password().is_some() || u.fragment().is_some() {
            return Err(error("CI pagination leaves the reviewed repository or API origin."));
        }
        next = Some(format!(
            "{}{}",
            u.path().strip_prefix(base.path().trim_end_matches('/')).ok_or_else(|| error("Invalid CI pagination path."))?,
            u.query().map(|q| format!("?{q}")).unwrap_or_default()
        ));
    }
    Ok(next)
}
fn paged(repo: &Path, f: &ForgeInfo, path: impl Fn(usize) -> String, pointer: &str) -> GitResult<Vec<Value>> {
    let mut all = vec![];
    let mut page = 1;
    let mut current = path(page);
    let mut visited = std::collections::BTreeSet::new();
    for _ in 0..50 {
        if !visited.insert(current.clone()) {
            return Err(error("Repeated CI page."));
        }
        let response = forge::raw_request(repo, f, &current, "application/json", 4 * 1024 * 1024, false)?;
        let v: Value = serde_json::from_slice(&response.bytes).map_err(|_| error("Invalid CI JSON response."))?;
        let values = rows(&v, pointer)?;
        all.extend(values.clone());
        if serde_json::to_vec(&all).map_err(|_| error("Invalid CI data."))?.len() > 8 * 1024 * 1024 {
            return Err(error("CI data exceeds the bounded complete preview."));
        }
        if let Some(link) = &response.link {
            match next_link(f, &current, link)? {
                Some(next) => {
                    current = next;
                    continue;
                }
                None => return Ok(all),
            }
        }
        if let Some(next) = &response.next_page {
            if next.is_empty() {
                return Ok(all);
            }
            let next = next.parse::<usize>().ok().filter(|n| *n > page).ok_or_else(|| error("Invalid next CI page index."))?;
            page = next;
            current = path(page);
            continue;
        }
        if values.len() < 100 {
            return Ok(all);
        }
        page += 1;
        current = path(page);
    }
    Err(error("CI data exceeds the complete-preview limit. Open the server; no merge was enabled."))
}
pub(super) fn load(repo: &Path, f: &ForgeInfo, d: &Detail) -> GitResult<Vec<forge::Check>> {
    let sha = &d.pull.head_sha;
    if !oid(sha) {
        return Err(error("A complete source SHA is required for CI."));
    }
    let mut out = vec![];
    match f.kind.as_str() {
        "github" => {
            let base = format!("/repos/{}/commits/{sha}", forge::project_path(&f.project));
            for r in paged(repo, f, |p| format!("{base}/check-runs?filter=latest&per_page=100&page={p}"), "/check_runs")? {
                out.push(check(
                    text(&r, "/name"),
                    if text(&r, "/status") == "completed" { r["conclusion"].as_str().unwrap_or("") } else { "pending" },
                    text(&r, "/html_url"),
                ));
            }
            // Combined status is already reduced to the newest status per context by GitHub.
            for r in paged(repo, f, |p| format!("{base}/status?per_page=100&page={p}"), "/statuses")? {
                out.push(check(text(&r, "/context"), &text(&r, "/state"), text(&r, "/target_url")));
            }
        }
        "gitlab" => {
            let base = format!("/projects/{}/repository/commits/{sha}/statuses", forge::enc(&f.project));
            for r in paged(repo, f, |p| format!("{base}?all=false&per_page=100&page={p}"), "")? {
                out.push(check(text(&r, "/name"), &text(&r, "/status"), text(&r, "/target_url")));
            }
        }
        "azure" => {
            let base = format!("{}/commits/{sha}/statuses", forge::azure_repo(f));
            // Azure commit statuses use skip/top (without dollar signs); don't depend on hidden continuation headers.
            let mut latest = std::collections::BTreeMap::new();
            for r in paged(repo, f, |p| format!("{base}?top=100&skip={}&latestOnly=true&api-version=7.1", (p - 1) * 100), "/value")? {
                let key = format!("{} / {}", text(&r, "/context/genre"), text(&r, "/context/name"));
                let id = r["id"].as_u64().ok_or_else(|| error("Azure CI status is missing its sequence ID."))?;
                if latest.get(&key).is_none_or(|(old, _)| id > *old) {
                    latest.insert(key.clone(), (id, check(key, &text(&r, "/state"), text(&r, "/targetUrl"))));
                }
            }
            out = latest.into_values().map(|(_, c)| c).collect();
        }
        _ => {
            out = bitbucket(f, sha, |p| forge::request(repo, f, "GET", p, None))?;
        }
    }
    Ok(out)
}
pub(super) fn caution(p: &mut Plan) {
    let n = p.checks.iter().filter(|c| !matches!(c.state.as_str(), "success" | "neutral" | "skipped")).count();
    if n > 0 {
        p.block(format!("{n} reported CI checks are pending, failed or cancelled. Refresh after they finish successfully."));
    }
    if p.checks.is_empty() {
        p.notices.push("No source-commit CI checks were reported. This does not prove that required server checks are satisfied.".into());
    }
}
