//! Published review actions. No implicit Git operations or automatic write retries.
use super::{
    diff,
    forge::{self, ForgeInfo},
    pr_center::{self, endpoint, hash, text, Detail},
    runner::{GitError, GitResult},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path};
const PAGE: usize = 50;
fn err(s: &str) -> GitError {
    GitError::new(s).kind("pr-review")
}
fn stale() -> GitError {
    GitError::new("The PR, account or discussion changed. Refresh before sending; your text was not sent.").kind("stale-operation")
}
fn array<'a>(v: &'a Value, p: &str) -> GitResult<&'a Vec<Value>> {
    v.pointer(p).and_then(Value::as_array).ok_or_else(|| err("The server returned an incomplete discussion response."))
}
fn id(v: &Value, p: &str) -> String {
    v.pointer(p).map(|v| v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string())).unwrap_or_default()
}
fn boolean(v: &Value, p: &str) -> bool {
    v.pointer(p).and_then(Value::as_bool) == Some(true)
}
fn scoped(repo: &Path, n: u64, connection: &str, revision: &str) -> GitResult<(ForgeInfo, Detail, Value)> {
    let f = forge::reviewed_connection(repo, connection)?;
    let (d, v) = pr_center::load_detail(repo, &f, n)?;
    if d.revision != revision || revision.is_empty() {
        return Err(stale());
    }
    Ok((f, d, v))
}
fn route(f: &ForgeInfo, n: u64, suffix: &str) -> String {
    format!("{}/{n}{suffix}", endpoint(f))
}
fn azure(f: &ForgeInfo, n: u64, suffix: &str) -> String {
    format!("{}?api-version=7.1", route(f, n, suffix))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub actor: String,
    pub actor_id: String,
    pub comment: bool,
    pub approve: bool,
    pub request_changes: bool,
    pub inline: bool,
    pub reason: String,
    pub summary_with_vote: bool,
}
pub fn capabilities(repo: &Path, n: u64, connection: &str, revision: &str) -> GitResult<Capabilities> {
    let (f, d, v) = scoped(repo, n, connection, revision)?;
    caps(repo, &f, &d, &v)
}
fn caps(repo: &Path, f: &ForgeInfo, d: &Detail, v: &Value) -> GitResult<Capabilities> {
    let mut c = Capabilities {
        actor: "Git credentials".into(),
        actor_id: "git-credentials".into(),
        comment: true,
        approve: false,
        request_changes: false,
        inline: true,
        reason: "The server checks token write scopes and current permissions when you send.".into(),
        summary_with_vote: f.kind == "github",
    };
    match f.kind.as_str() {
        "github" => {
            let u = forge::request(repo, f, "GET", "/user", None)?;
            c.actor = text(&u, "/login");
            c.actor_id = id(&u, "/id");
            let r = forge::request(repo, f, "GET", &format!("/repos/{}", forge::project_path(&f.project)), None)?;
            c.comment = !boolean(&r, "/archived") && (!boolean(v, "/locked") || boolean(&r, "/permissions/push"));
            let author = id(v, "/user/id") == c.actor_id || text(v, "/user/login").eq_ignore_ascii_case(&c.actor);
            c.approve = c.comment && !author;
            c.request_changes = c.approve;
            if author {
                c.reason = "GitHub does not allow approving or requesting changes on your own PR. Comments remain available.".into();
            }
        }
        "gitlab" => {
            let u = forge::request(repo, f, "GET", "/user", None)?;
            c.actor = text(&u, "/username");
            c.actor_id = id(&u, "/id");
            let a = forge::request(repo, f, "GET", &route(f, d.pull.number, "/approvals"), None);
            match a {
                Ok(a) => c.approve = boolean(&a, "/user_can_approve"),
                Err(e) if matches!(e.kind.as_str(), "auth" | "forge-http") => {}
                Err(e) => return Err(e),
            };
            c.reason="GitLab approval eligibility is checked on the server. Request Changes is not exposed by this REST integration; use GitLab for that action. Token write scopes are checked when sending.".into();
        }
        "bitbucket" => {
            let u = forge::request(repo, f, "GET", "/user", None)?;
            c.actor = text(&u, "/display_name");
            c.actor_id = text(&u, "/uuid");
            c.approve = c.actor_id != text(v, "/author/uuid");
            c.request_changes = c.approve;
        }
        "azure" => {
            let u = forge::request(repo, f, "GET", "/_apis/connectionData?api-version=7.1-preview.1", None)?;
            c.actor = text(&u, "/authenticatedUser/providerDisplayName");
            c.actor_id = text(&u, "/authenticatedUser/id");
            c.approve = true;
            c.request_changes = true;
        }
        _ => {
            c.reason="Bitbucket Server comments use Git credentials and server permissions. Voting requires a verified API identity; use the server for Approve or Request Changes.".into();
        }
    }
    if c.actor_id.is_empty() || c.actor.is_empty() {
        return Err(err("Could not verify the active review identity."));
    }
    if d.pull.state != "open" {
        c.approve = false;
        c.request_changes = false;
        c.inline = false;
        c.reason = "Voting and new inline comments require an open PR. The server determines whether discussion comments remain allowed.".into();
    }
    forge::reviewed_connection(repo, f.connection_revision.as_deref().unwrap_or_default())?;
    Ok(c)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub author: String,
    pub body: String,
    pub created: String,
    pub state: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub revision: String,
    pub path: Option<String>,
    pub side: String,
    pub line: Option<u32>,
    pub outdated: bool,
    pub resolved: Option<bool>,
    pub can_reply: bool,
    pub can_resolve: bool,
    pub complete: bool,
    pub comments: Vec<Comment>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub items: Vec<Thread>,
    pub next_cursor: Option<String>,
    pub notice: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    key: String,
    offset: usize,
    after: Option<String>,
}
const GH_FIELDS:&str="id path diffSide line originalLine isOutdated isResolved viewerCanReply viewerCanResolve viewerCanUnresolve comments(first:100){nodes{fullDatabaseId body createdAt author{login} pullRequestReview{state}} pageInfo{hasNextPage endCursor}}";
fn gh_thread(v: &Value) -> GitResult<Thread> {
    let comments = array(v, "/comments/nodes")?
        .iter()
        .map(|c| Comment {
            id: if c.get("fullDatabaseId").is_some_and(|v| !v.is_null()) { id(c, "/fullDatabaseId") } else { id(c, "/databaseId") },
            author: text(c, "/author/login"),
            body: text(c, "/body"),
            created: text(c, "/createdAt"),
            state: text(c, "/pullRequestReview/state"),
        })
        .collect();
    let resolved = boolean(v, "/isResolved");
    Ok(Thread {
        id: text(v, "/id"),
        revision: hash(v.to_string()),
        path: Some(text(v, "/path")),
        side: text(v, "/diffSide"),
        line: v.get("line").and_then(Value::as_u64).or_else(|| v.get("originalLine").and_then(Value::as_u64)).and_then(|n| n.try_into().ok()),
        outdated: boolean(v, "/isOutdated"),
        resolved: Some(resolved),
        can_reply: boolean(v, "/viewerCanReply"),
        can_resolve: if resolved { boolean(v, "/viewerCanUnresolve") } else { boolean(v, "/viewerCanResolve") },
        complete: !boolean(v, "/comments/pageInfo/hasNextPage"),
        comments,
    })
}
fn gl_thread(v: &Value) -> GitResult<Thread> {
    let notes = array(v, "/notes")?;
    let first = notes.first().ok_or_else(|| err("Discussion has no notes."))?;
    let position = &first["position"];
    let outdated = position.get("head_sha").is_some_and(Value::is_null);
    let comments = notes
        .iter()
        .map(|c| Comment {
            id: id(c, "/id"),
            author: text(c, "/author/username"),
            body: text(c, "/body"),
            created: text(c, "/created_at"),
            state: if boolean(c, "/system") { "system" } else { "comment" }.into(),
        })
        .collect();
    let has_new = position.get("new_line").is_some_and(|v| !v.is_null());
    Ok(Thread {
        id: id(v, "/id"),
        revision: hash(v.to_string()),
        path: position.get(if has_new { "new_path" } else { "old_path" }).and_then(Value::as_str).map(str::to_owned),
        side: if has_new { "RIGHT" } else { "LEFT" }.into(),
        line: position.get(if has_new { "new_line" } else { "old_line" }).and_then(Value::as_u64).and_then(|n| n.try_into().ok()),
        outdated,
        resolved: if boolean(first, "/resolvable") { Some(boolean(first, "/resolved")) } else { None },
        can_reply: !boolean(v, "/individual_note"),
        can_resolve: boolean(first, "/resolvable"),
        complete: true,
        comments,
    })
}
fn gitlab_outdated(t: &mut Thread, v: &Value, head: &str) {
    let original = text(v, "/notes/0/position/head_sha");
    if t.path.is_some() && !original.is_empty() {
        t.outdated = original != head;
    }
}
fn bb_comment(v: &Value) -> Comment {
    Comment {
        id: id(v, "/id"),
        author: text(v, "/user/display_name"),
        body: if boolean(v, "/deleted") { "[Deleted comment]".into() } else { text(v, "/content/raw") },
        created: text(v, "/created_on"),
        state: "comment".into(),
    }
}
fn bb_thread(v: &Value) -> Thread {
    let new = v.pointer("/inline/to").and_then(Value::as_u64);
    Thread {
        id: id(v, "/id"),
        revision: hash(serde_json::to_vec(v).unwrap_or_default()),
        path: v.pointer("/inline/path").and_then(Value::as_str).map(str::to_owned),
        side: if new.is_some() { "RIGHT" } else { "LEFT" }.into(),
        line: new.or_else(|| v.pointer("/inline/from").and_then(Value::as_u64)).and_then(|n| n.try_into().ok()),
        outdated: boolean(v, "/inline/outdated"),
        resolved: Some(v.get("resolution").is_some_and(|v| !v.is_null())),
        can_reply: !boolean(v, "/deleted"),
        can_resolve: !boolean(v, "/deleted"),
        // The comment endpoint returns only the root, never the full reply collection.
        complete: false,
        comments: vec![bb_comment(v)],
    }
}
fn az_thread(v: &Value) -> GitResult<Thread> {
    let status = text(v, "/status");
    let closed = !matches!(status.as_str(), "active" | "pending" | "1" | "6" | "");
    let new = v.pointer("/threadContext/rightFileStart/line").and_then(Value::as_u64);
    Ok(Thread {
        id: id(v, "/id"),
        revision: hash(v.to_string()),
        path: v.pointer("/threadContext/filePath").and_then(Value::as_str).map(|p| p.trim_start_matches('/').into()),
        side: if new.is_some() { "RIGHT" } else { "LEFT" }.into(),
        line: new.or_else(|| v.pointer("/threadContext/leftFileStart/line").and_then(Value::as_u64)).and_then(|n| n.try_into().ok()),
        outdated: false,
        resolved: Some(closed),
        can_reply: !boolean(v, "/isDeleted"),
        can_resolve: !boolean(v, "/isDeleted"),
        complete: true,
        comments: array(v, "/comments")?
            .iter()
            .map(|c| Comment {
                id: id(c, "/id"),
                author: text(c, "/author/displayName"),
                body: if boolean(c, "/isDeleted") { "[Deleted comment]".into() } else { text(c, "/content") },
                created: text(c, "/publishedDate"),
                state: text(c, "/commentType"),
            })
            .collect(),
    })
}
fn bbs_thread(v: &Value) -> GitResult<Thread> {
    fn visit(v: &Value, out: &mut Vec<Comment>, depth: usize) -> GitResult<()> {
        if depth > 20 || out.len() > 2000 {
            return Err(err("Discussion exceeds the local preview limit; use the server."));
        }
        out.push(Comment {
            id: id(v, "/id"),
            author: text(v, "/author/displayName"),
            body: text(v, "/text"),
            created: v.get("createdDate").and_then(Value::as_i64).map(forge::iso_from_millis).unwrap_or_default(),
            state: text(v, "/state"),
        });
        if let Some(children) = v.get("comments").and_then(Value::as_array) {
            for c in children {
                visit(c, out, depth + 1)?;
            }
        }
        Ok(())
    }
    let mut comments = vec![];
    visit(v, &mut comments, 0)?;
    Ok(Thread {
        id: id(v, "/id"),
        revision: hash(v.to_string()),
        path: v.pointer("/anchor/path").and_then(|p| {
            p.as_str()
                .map(str::to_owned)
                .or_else(|| p.get("components").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("/")))
        }),
        side: if text(v, "/anchor/fileType") == "FROM" { "LEFT" } else { "RIGHT" }.into(),
        line: v.pointer("/anchor/line").and_then(Value::as_u64).and_then(|n| n.try_into().ok()),
        outdated: boolean(v, "/anchor/orphaned"),
        resolved: v.get("threadResolved").and_then(Value::as_bool),
        can_reply: true,
        can_resolve: v.get("threadResolved").is_some() && v.get("version").and_then(Value::as_u64).is_some() && boolean(v, "/permittedOperations/editable"),
        complete: true,
        comments,
    })
}
fn singleton(v: &Value, feed: &str, kind: &str) -> Thread {
    let (ident, author, body, created, state) = if kind == "github" {
        (id(v, "/id"), text(v, "/user/login"), text(v, "/body"), text(v, "/created_at"), text(v, "/state"))
    } else {
        (id(v, "/id"), text(v, "/author"), text(v, "/body"), text(v, "/created"), text(v, "/state"))
    };
    Thread {
        id: format!("{feed}:{ident}"),
        revision: hash(serde_json::to_vec(v).unwrap_or_default()),
        path: None,
        side: "RIGHT".into(),
        line: None,
        outdated: false,
        resolved: None,
        can_reply: false,
        can_resolve: false,
        complete: true,
        comments: vec![Comment { id: ident, author, body, created, state }],
    }
}

pub fn page(repo: &Path, n: u64, connection: &str, revision: &str, feed: &str, cursor: Option<&str>) -> GitResult<Page> {
    let (f, d, v) = scoped(repo, n, connection, revision)?;
    if !["threads", "comments", "reviews"].contains(&feed) {
        return Err(err("Invalid review feed."));
    }
    let key = hash(format!("{connection}:{n}:{revision}:{feed}"));
    let c = match cursor {
        Some(s) if s.len() <= 4096 => serde_json::from_str::<Cursor>(s).map_err(|_| err("Invalid discussion cursor."))?,
        Some(_) => return Err(err("Invalid discussion cursor.")),
        None => Cursor { key: key.clone(), offset: 0, after: None },
    };
    if c.key != key || c.offset > 100_000 {
        return Err(stale());
    }
    let mut after = None;
    let mut next = None;
    let mut notice = None;
    let items = if f.kind == "github" && feed == "threads" {
        let (owner, name) = f.project.split_once('/').ok_or_else(|| err("Invalid GitHub repository."))?;
        let query=format!("query($owner:String!,$name:String!,$number:Int!,$after:String){{repository(owner:$owner,name:$name){{pullRequest(number:$number){{headRefOid reviewThreads(first:50,after:$after){{nodes{{{GH_FIELDS}}} pageInfo{{hasNextPage endCursor}}}}}}}}}}");
        let data = forge::graphql(repo, &f, &query, json!({"owner":owner,"name":name,"number":n,"after":c.after}))?;
        if text(&data, "/repository/pullRequest/headRefOid") != d.pull.head_sha {
            return Err(stale());
        }
        let list = &data["repository"]["pullRequest"]["reviewThreads"];
        if boolean(list, "/pageInfo/hasNextPage") {
            after = Some(text(list, "/pageInfo/endCursor"));
            if after.as_deref() == Some("") || after == c.after {
                return Err(err("Non-advancing discussion cursor."));
            }
            next = Some(c.offset + PAGE);
        }
        array(list, "/nodes")?.iter().map(gh_thread).collect::<GitResult<Vec<_>>>()?
    } else if f.kind == "github" {
        let path = if feed == "comments" {
            format!("/repos/{}/issues/{n}/comments?per_page=50&page={}", forge::project_path(&f.project), c.offset / PAGE + 1)
        } else {
            format!("{}?per_page=50&page={}", route(&f, n, "/reviews"), c.offset / PAGE + 1)
        };
        let data = forge::request(repo, &f, "GET", &path, None)?;
        let rows = array(&data, "")?;
        if rows.len() >= PAGE {
            next = Some(c.offset + PAGE);
        }
        rows.iter().map(|v| singleton(v, feed, "github")).collect()
    } else if feed == "reviews" {
        notice = Some("Current review/approval status, not a complete review event history.".into());
        let rows=match f.kind.as_str(){"gitlab"=>{let a=forge::request(repo,&f,"GET",&route(&f,n,"/approvals"),None)?;array(&a,"/approved_by")?.iter().map(|x|json!({"id":id(x,"/user/id"),"author":text(x,"/user/username"),"state":"APPROVED","body":"","created":text(x,"/approved_at")})).collect::<Vec<_>>()},"azure"=>array(&v,"/reviewers")?.iter().map(|x|json!({"id":id(x,"/id"),"author":text(x,"/displayName"),"state":format!("vote {}",id(x,"/vote")),"body":"","created":""})).collect(),_=>v.get(if f.kind=="bitbucket"{"participants"}else{"reviewers"}).and_then(Value::as_array).ok_or_else(||err("Missing review status."))?.iter().map(|x|json!({"id":id(x,"/user/uuid")+&id(x,"/user/id"),"author":text(x,"/user/display_name")+&text(x,"/user/displayName"),"state":if boolean(x,"/approved"){"APPROVED".into()}else{text(x,"/state")+&text(x,"/status")},"body":"","created":""})).collect()};
        if rows.len() > c.offset + PAGE {
            next = Some(c.offset + PAGE);
        }
        rows.iter().skip(c.offset).take(PAGE).map(|x| singleton(x, feed, "other")).collect()
    } else if f.kind == "gitlab" {
        let data = forge::request(repo, &f, "GET", &format!("{}?per_page=50&page={}", route(&f, n, "/discussions"), c.offset / PAGE + 1), None)?;
        let rows = array(&data, "")?;
        if rows.len() >= PAGE {
            next = Some(c.offset + PAGE);
        }
        rows.iter()
            .map(|v| {
                let mut t = gl_thread(v)?;
                gitlab_outdated(&mut t, v, &d.pull.head_sha);
                Ok(t)
            })
            .collect::<GitResult<Vec<_>>>()?
    } else if f.kind == "azure" {
        let data = forge::request(repo, &f, "GET", &azure(&f, n, "/threads"), None)?;
        let rows = array(&data, "/value")?;
        if rows.len() > 2000 {
            return Err(err("More than 2,000 discussion threads; use the server for this PR."));
        }
        if rows.len() > c.offset + PAGE {
            next = Some(c.offset + PAGE);
        }
        rows.iter().skip(c.offset).take(PAGE).map(az_thread).collect::<GitResult<Vec<_>>>()?
    } else if f.kind == "bitbucket" {
        let data = forge::request(repo, &f, "GET", &format!("{}?pagelen=50&page={}", route(&f, n, "/comments"), c.offset / PAGE + 1), None)?;
        if data.get("next").and_then(Value::as_str).is_some() {
            next = Some(c.offset + PAGE);
        }
        let mut groups: BTreeMap<String, Thread> = BTreeMap::new();
        for item in array(&data, "/values")? {
            let mut root = item.clone();
            let mut depth = 0;
            while root.pointer("/parent/id").is_some_and(|x| !x.is_null()) {
                depth += 1;
                if depth > 20 {
                    return Err(err("Invalid comment parent chain."));
                }
                root = forge::request(repo, &f, "GET", &route(&f, n, &format!("/comments/{}", forge::enc(&id(&root, "/parent/id")))), None)?;
            }
            let t = groups.entry(id(&root, "/id")).or_insert_with(|| bb_thread(&root));
            let comment = bb_comment(item);
            if !t.comments.iter().any(|c| c.id == comment.id) {
                t.comments.push(comment);
            }
        }
        notice = Some(
            "Replies are collected from loaded comment pages. Load further pages to read the rest; permissions are checked by Bitbucket when sending.".into(),
        );
        groups.into_values().collect()
    } else {
        let data = forge::request(repo, &f, "GET", &format!("{}?limit=50&start={}", route(&f, n, "/activities"), c.offset), None)?;
        if !boolean(&data, "/isLastPage") {
            next =
                Some(data.get("nextPageStart").and_then(Value::as_u64).and_then(|n| n.try_into().ok()).ok_or_else(|| err("Missing discussion page offset."))?);
        }
        array(&data, "/values")?.iter().filter_map(|v| v.get("comment")).map(bbs_thread).collect::<GitResult<Vec<_>>>()?
    };
    if next.is_some_and(|n| n <= c.offset) {
        return Err(err("Non-advancing discussion page."));
    }
    forge::reviewed_connection(repo, connection)?;
    Ok(Page { items, next_cursor: next.map(|offset| serde_json::to_string(&Cursor { key, offset, after }).unwrap()), notice })
}

pub fn thread(repo: &Path, n: u64, connection: &str, revision: &str, thread: &str) -> GitResult<Thread> {
    let (f, d, _) = scoped(repo, n, connection, revision)?;
    let (mut result, raw) = read_thread(repo, &f, n, thread)?;
    if f.kind == "gitlab" {
        gitlab_outdated(&mut result, &raw, &d.pull.head_sha);
    }
    scoped(repo, n, connection, revision)?;
    Ok(result)
}
fn read_thread(repo: &Path, f: &ForgeInfo, n: u64, thread: &str) -> GitResult<(Thread, Value)> {
    if thread.is_empty() || thread.len() > 256 {
        return Err(err("Invalid discussion ID."));
    }
    if f.kind == "github" {
        let query =
            format!("query($id:ID!){{node(id:$id){{... on PullRequestReviewThread{{{GH_FIELDS} pullRequest{{number repository{{nameWithOwner}}}}}}}}}}");
        let data = forge::graphql(repo, f, &query, json!({"id":thread}))?;
        let v = &data["node"];
        if v.pointer("/pullRequest/number").and_then(Value::as_u64) != Some(n)
            || !text(v, "/pullRequest/repository/nameWithOwner").eq_ignore_ascii_case(&f.project)
        {
            return Err(err("Discussion belongs to another PR."));
        }
        let mut normalized = v.clone();
        normalized.as_object_mut().ok_or_else(|| err("Missing discussion."))?.remove("pullRequest");
        let mut cursor = text(&normalized, "/comments/pageInfo/endCursor");
        let mut rounds = 0;
        while boolean(&normalized, "/comments/pageInfo/hasNextPage") {
            rounds += 1;
            if rounds > 50 || normalized.to_string().len() > 4 * 1024 * 1024 {
                return Err(err("Discussion exceeds the local preview limit; use GitHub."));
            }
            let query = "query($id:ID!,$after:String){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$after){nodes{fullDatabaseId body createdAt author{login} pullRequestReview{state}} pageInfo{hasNextPage endCursor}}}}}";
            let more = forge::graphql(repo, f, query, json!({"id":thread,"after":cursor}))?;
            let comments = &more["node"]["comments"];
            let rows = array(comments, "/nodes")?.clone();
            normalized["comments"]["nodes"].as_array_mut().unwrap().extend(rows);
            let next = text(comments, "/pageInfo/endCursor");
            if boolean(comments, "/pageInfo/hasNextPage") && (next.is_empty() || next == cursor) {
                return Err(err("Non-advancing reply cursor."));
            }
            cursor = next;
            normalized["comments"]["pageInfo"] = comments["pageInfo"].clone();
        }
        if normalized.to_string().len() > 4 * 1024 * 1024 || array(&normalized, "/comments/nodes")?.len() > 5000 {
            return Err(err("Discussion exceeds the local preview limit; use GitHub."));
        }
        return Ok((gh_thread(&normalized)?, normalized));
    }
    let path = match f.kind.as_str() {
        "gitlab" => route(f, n, &format!("/discussions/{}", forge::enc(thread))),
        "azure" => azure(f, n, &format!("/threads/{}", forge::enc(thread))),
        _ => route(f, n, &format!("/comments/{}", forge::enc(thread))),
    };
    let v = forge::request(repo, f, "GET", &path, None)?;
    let t = match f.kind.as_str() {
        "gitlab" => gl_thread(&v)?,
        "azure" => az_thread(&v)?,
        "bitbucket" => bb_thread(&v),
        _ => bbs_thread(&v)?,
    };
    if t.id != thread {
        return Err(err("The server returned a different discussion."));
    }
    Ok((t, v))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Anchor {
    pub file_id: String,
    pub side: String,
    pub line: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Action {
    pub kind: String,
    pub body: String,
    pub expected_actor: String,
    pub thread: Option<String>,
    pub thread_revision: Option<String>,
    pub anchor: Option<Anchor>,
}
fn validate_body(body: &str, required: bool) -> GitResult<()> {
    if body.len() > 65536 || body.contains('\0') || required && body.trim().is_empty() {
        Err(err("Enter a comment of at most 64 KiB without NUL characters."))
    } else {
        Ok(())
    }
}
fn line<'a>(diff: &'a diff::FileDiff, a: &Anchor) -> GitResult<&'a diff::DiffLine> {
    if !["LEFT", "RIGHT"].contains(&a.side.as_str()) || a.line == 0 || diff.binary {
        return Err(err("Choose a text line in the reviewed diff."));
    }
    diff.hunks
        .iter()
        .flat_map(|h| &h.lines)
        .find(|l| if a.side == "LEFT" { l.old_no == Some(a.line) } else { l.new_no == Some(a.line) })
        .ok_or_else(|| err("The selected line is not in the reviewed diff."))
}
pub fn act(repo: &Path, n: u64, connection: &str, revision: &str, a: Action) -> GitResult<()> {
    let (f, d, v) = scoped(repo, n, connection, revision)?;
    let c = caps(repo, &f, &d, &v)?;
    if c.actor_id != a.expected_actor {
        return Err(stale());
    }
    let vote = matches!(a.kind.as_str(), "approve" | "request_changes");
    if !["comment", "reply", "resolve", "reopen", "approve", "request_changes"].contains(&a.kind.as_str()) {
        return Err(err("Unknown review action."));
    }
    validate_body(&a.body, matches!(a.kind.as_str(), "comment" | "reply") || f.kind == "github" && a.kind == "request_changes")?;
    if vote && (!c.approve && a.kind == "approve" || !c.request_changes && a.kind == "request_changes") {
        return Err(err(&c.reason));
    }
    if matches!(a.kind.as_str(), "comment" | "reply") && !c.comment {
        return Err(err("Comments are not permitted for this PR."));
    }
    if vote && !c.summary_with_vote && !a.body.is_empty() {
        return Err(err("This provider sends votes separately from comments. Post the summary as a general comment first."));
    }
    let mut body = json!({});
    let (method, path) = if vote {
        match f.kind.as_str() {
            "github" => {
                body = json!({"event":if a.kind=="approve"{"APPROVE"}else{"REQUEST_CHANGES"},"body":a.body,"commit_id":d.pull.head_sha});
                ("POST", route(&f, n, "/reviews"))
            }
            "gitlab" => {
                body = json!({"sha":d.pull.head_sha});
                ("POST", route(&f, n, "/approve"))
            }
            "bitbucket" => ("POST", route(&f, n, if a.kind == "approve" { "/approve" } else { "/request-changes" })),
            "azure" => {
                body = json!({"vote":if a.kind=="approve"{10}else{-5},"isReapprove":true});
                ("PUT", azure(&f, n, &format!("/reviewers/{}", forge::enc(&c.actor_id))))
            }
            _ => return Err(err(&c.reason)),
        }
    } else if a.kind == "reply" || a.kind == "resolve" || a.kind == "reopen" {
        let tid = a.thread.as_deref().ok_or_else(|| err("Choose a discussion."))?;
        let (t, raw) = read_thread(repo, &f, n, tid)?;
        if a.thread_revision.as_deref() != Some(t.revision.as_str()) {
            return Err(stale());
        }
        if a.kind == "reply" && !t.can_reply || a.kind != "reply" && (!t.can_resolve || t.resolved.is_none()) {
            return Err(err("This action is not available for this discussion or your account."));
        }
        if a.kind != "reply" && t.resolved == Some(a.kind == "resolve") {
            return Err(stale());
        }
        if f.kind == "github" && a.kind != "reply" {
            let mutation = if a.kind == "resolve" { "resolveReviewThread" } else { "unresolveReviewThread" };
            let query = format!("mutation($id:ID!){{{mutation}(input:{{threadId:$id}}){{thread{{id isResolved}}}}}}");
            scoped(repo, n, connection, revision)?;
            let result = forge::graphql_as(repo, &f, &query, json!({"id":tid}), Some(&a.expected_actor)).map_err(|e| {
                if e.kind == "forge-graphql" {
                    err("The discussion update result is uncertain. Refresh the server before retrying.").kind("forge-write-uncertain")
                } else {
                    pr_center::uncertain(e)
                }
            })?;
            if text(&result, &format!("/{mutation}/thread/id")) != tid
                || result.pointer(&format!("/{mutation}/thread/isResolved")).and_then(Value::as_bool) != Some(a.kind == "resolve")
            {
                return Err(err("The discussion update result is incomplete. Check the server before retrying.").kind("forge-write-uncertain"));
            }
            return Ok(());
        }
        match f.kind.as_str() {
            "github" => {
                let first = t.comments.first().ok_or_else(|| err("Missing root comment."))?;
                if first.id.parse::<u64>().ok().is_none_or(|id| id == 0) {
                    return Err(err("GitHub did not return a valid root comment ID. Refresh or reply on the server."));
                }
                body = json!({"body":a.body});
                ("POST", route(&f, n, &format!("/comments/{}/replies", forge::enc(&first.id))))
            }
            "gitlab" => {
                if a.kind == "reply" {
                    body = json!({"body":a.body});
                    ("POST", route(&f, n, &format!("/discussions/{}/notes", forge::enc(tid))))
                } else {
                    body = json!({"resolved":a.kind=="resolve"});
                    ("PUT", route(&f, n, &format!("/discussions/{}", forge::enc(tid))))
                }
            }
            "bitbucket" => {
                if a.kind == "reply" {
                    body = json!({"content":{"raw":a.body},"parent":{"id":tid.parse::<u64>().map_err(|_|err("Invalid comment ID."))?}});
                    ("POST", route(&f, n, "/comments"))
                } else {
                    (if a.kind == "resolve" { "POST" } else { "DELETE" }, route(&f, n, &format!("/comments/{}/resolve", forge::enc(tid))))
                }
            }
            "azure" => {
                if a.kind == "reply" {
                    body = json!({"content":a.body,"parentCommentId":0,"commentType":1});
                    ("POST", azure(&f, n, &format!("/threads/{}/comments", forge::enc(tid))))
                } else {
                    body = json!({"status":if a.kind=="resolve"{2}else{1}});
                    ("PATCH", azure(&f, n, &format!("/threads/{}", forge::enc(tid))))
                }
            }
            _ => {
                if a.kind == "reply" {
                    body = json!({"text":a.body,"parent":{"id":tid.parse::<u64>().map_err(|_|err("Invalid comment ID."))?}});
                    ("POST", route(&f, n, "/comments"))
                } else {
                    body = json!({"version":raw["version"],"text":raw["text"],"threadResolved":a.kind=="resolve"});
                    ("PUT", route(&f, n, &format!("/comments/{}", forge::enc(tid))))
                }
            }
        }
    } else {
        let anchor = if let Some(a) = &a.anchor {
            if !c.inline {
                return Err(err("Inline commenting is unavailable for this PR."));
            }
            let view = pr_center::file(repo, n, connection, revision, &a.file_id)?;
            let diff = view.diff.ok_or_else(|| err("A complete diff is required for an inline comment."))?;
            let l = line(&diff, a)?.clone();
            Some((diff, l, a))
        } else {
            None
        };
        match f.kind.as_str() {
            "github" => {
                body = json!({"body":a.body});
                if let Some((diff, _, anchor)) = anchor {
                    body["commit_id"] = json!(d.pull.head_sha);
                    body["path"] = json!(diff.path);
                    body["side"] = json!(anchor.side);
                    body["line"] = json!(anchor.line);
                    ("POST", route(&f, n, "/comments"))
                } else {
                    ("POST", format!("/repos/{}/issues/{n}/comments", forge::project_path(&f.project)))
                }
            }
            "gitlab" => {
                body = json!({"body":a.body});
                if let Some((diff, l, _)) = anchor {
                    if text(&v, "/diff_refs/head_sha") != d.pull.head_sha {
                        return Err(stale());
                    }
                    let mut p = json!({"position_type":"text","base_sha":d.diff_base_sha,"start_sha":d.base_sha,"head_sha":d.pull.head_sha,"old_path":diff.old_path.as_deref().unwrap_or(&diff.path),"new_path":diff.path});
                    if let Some(old) = l.old_no {
                        p["old_line"] = json!(old);
                    }
                    if let Some(new) = l.new_no {
                        p["new_line"] = json!(new);
                    }
                    body["position"] = p;
                }
                ("POST", route(&f, n, "/discussions"))
            }
            "bitbucket" => {
                body = json!({"content":{"raw":a.body}});
                if let Some((diff, _, anchor)) = anchor {
                    body["inline"] = json!({"path":diff.path});
                    body["inline"][if anchor.side == "LEFT" { "from" } else { "to" }] = json!(anchor.line);
                }
                ("POST", route(&f, n, "/comments"))
            }
            "azure" => {
                body = json!({"comments":[{"parentCommentId":0,"content":a.body,"commentType":1}],"status":1});
                if let Some((diff, _, anchor)) = anchor {
                    let context = azure_anchor(repo, &f, &d, &diff, anchor)?;
                    body["threadContext"] = context["threadContext"].clone();
                    body["pullRequestThreadContext"] = context["pullRequestThreadContext"].clone();
                }
                ("POST", azure(&f, n, "/threads"))
            }
            _ => {
                body = json!({"text":a.body});
                if let Some((diff, l, anchor)) = anchor {
                    body["anchor"] = json!({"diffType":"EFFECTIVE","fromHash":d.base_sha,"toHash":d.pull.head_sha,"path":diff.path,"srcPath":diff.old_path.as_deref().unwrap_or(&diff.path),"line":anchor.line,"lineType":match l.kind.as_str(){"+"=>"ADDED","-"=>"REMOVED",_=>"CONTEXT"},"fileType":if anchor.side=="LEFT"{"FROM"}else{"TO"}});
                }
                ("POST", route(&f, n, "/comments"))
            }
        }
    };
    scoped(repo, n, connection, revision)?;
    forge::write_api(repo, &f, method, &path, if body == json!({}) { None } else { Some(body) }, &a.expected_actor).map_err(pr_center::uncertain)
}

fn azure_anchor(repo: &Path, f: &ForgeInfo, d: &Detail, diff: &diff::FileDiff, a: &Anchor) -> GitResult<Value> {
    let n = d.pull.number;
    let v = forge::request(repo, f, "GET", &azure(f, n, "/iterations"), None)?;
    let iterations = array(&v, "/value")?;
    let latest = iterations.iter().max_by_key(|x| x["id"].as_u64()).ok_or_else(|| err("Azure has no prepared PR iteration."))?;
    if text(latest, "/sourceRefCommit/commitId") != d.pull.head_sha || text(latest, "/targetRefCommit/commitId") != d.base_sha {
        return Err(stale());
    }
    let iteration = latest["id"].as_u64().filter(|n| *n > 0).ok_or_else(|| err("Invalid Azure iteration."))?;
    let compare = forge::request(
        repo,
        f,
        "GET",
        &format!(
            "{}/diffs/commits?baseVersion={}&baseVersionType=commit&targetVersion={}&targetVersionType=commit&diffCommonCommit=true&api-version=7.1",
            forge::azure_repo(f),
            d.base_sha,
            d.pull.head_sha
        ),
        None,
    )?;
    if text(latest, "/commonRefCommit/commitId") != text(&compare, "/commonCommit") {
        return Err(err("Azure's iteration merge base differs from this preview. Refresh or comment on the server."));
    }
    let mut skip = 0;
    for _ in 0..50 {
        let v = forge::request(
            repo,
            f,
            "GET",
            &format!("{}?$compareTo=0&$top=100&$skip={skip}&api-version=7.1", route(f, n, &format!("/iterations/{iteration}/changes"))),
            None,
        )?;
        let rows = array(&v, "/changeEntries")?;
        if let Some(e) = rows.iter().find(|e| text(e, "/item/path").trim_start_matches('/') == diff.path) {
            let tracking = e["changeTrackingId"].as_u64().ok_or_else(|| err("Missing Azure change tracking ID."))?;
            let position = json!({"line":a.line,"offset":1});
            let mut context = json!({"filePath":format!("/{}",diff.path)});
            context[if a.side == "LEFT" { "leftFileStart" } else { "rightFileStart" }] = position.clone();
            context[if a.side == "LEFT" { "leftFileEnd" } else { "rightFileEnd" }] = position;
            return Ok(
                json!({"threadContext":context,"pullRequestThreadContext":{"changeTrackingId":tracking,"iterationContext":{"firstComparingIteration":iteration,"secondComparingIteration":iteration}}}),
            );
        }
        let next = v["nextSkip"].as_u64().unwrap_or(0);
        if next == 0 {
            break;
        }
        if next <= skip {
            return Err(err("Invalid Azure changes pagination."));
        }
        skip = next;
    }
    Err(err("This file could not be matched to Azure's reviewed iteration. Comment on the server instead."))
}

#[cfg(test)]
#[path = "pr_reviews_tests.rs"]
mod tests;
