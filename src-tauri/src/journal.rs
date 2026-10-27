//! Persistent, bounded diagnostics. Journal failures never retry or undo Git work.
mod redact;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use fs2::FileExt;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::git::{operations, repo, runner::GitError};

type Result<T> = std::result::Result<T, String>;
const MAX_COMMANDS: u64 = 64;
const OUTPUT_BUDGET: i64 = 64 * 1024;
const MAX_ENTRIES: i64 = 2000;
const MAX_BYTES: i64 = 50 * 1024 * 1024;
const RETENTION_MS: i64 = 30 * 24 * 3600 * 1000;

static STORE: OnceLock<Mutex<Option<Arc<Journal>>>> = OnceLock::new();
static DIRECTORY: OnceLock<Option<PathBuf>> = OnceLock::new();
static WARNING: Mutex<Option<String>> = Mutex::new(None);
thread_local! { static CURRENT: RefCell<Vec<Arc<Context>>> = const { RefCell::new(Vec::new()) }; }

pub fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(i64::MAX as u128) as i64
}
fn diagnostic(error: impl std::fmt::Display) -> String {
    redact::bounded(&redact::text(&error.to_string()), 1024).0
}
fn warn(error: impl std::fmt::Display) {
    *WARNING.lock() = Some(diagnostic(error));
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub repo: String,
    pub repository_key: String,
    pub command: String,
    pub status: String,
    pub requested_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub wait_ms: Option<i64>,
    pub duration_ms: Option<i64>,
    pub before_head: Option<String>,
    pub after_head: Option<String>,
    pub outcome: Option<String>,
    pub error_kind: Option<String>,
    pub error: Option<String>,
    pub truncated: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub sequence: i64,
    pub cwd: String,
    pub args: Vec<String>,
    pub started_at: i64,
    pub duration_ms: Option<i64>,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub output_omitted: bool,
    pub truncated: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    pub entry: Entry,
    pub steps: Vec<Step>,
}

#[derive(Debug, Default, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub repo: Option<String>,
    pub status: Option<String>,
    pub search: Option<String>,
    pub since: Option<i64>,
    pub until: Option<i64>,
    pub before: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub entries: Vec<Entry>,
    pub next: Option<String>,
    pub total: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub available: bool,
    pub warning: Option<String>,
    pub path: Option<String>,
    pub retention_days: u32,
    pub max_entries: i64,
}

pub struct Journal {
    db: Mutex<Connection>,
    completions: Mutex<Completions>,
    path: PathBuf,
    session: String,
    _lock: tempfile::NamedTempFile,
    next: AtomicU64,
}

#[derive(Default)]
struct Completions {
    active: HashSet<String>,
    pending: HashMap<String, Terminal>,
}

#[derive(Clone)]
struct Terminal {
    status: &'static str,
    finished_at: i64,
    duration_ms: Option<i64>,
    outcome: Option<String>,
    kind: Option<String>,
    error: Option<String>,
}

impl Terminal {
    fn unknown() -> Self {
        Self {
            status: "interrupted",
            finished_at: now(),
            duration_ms: None,
            outcome: None,
            kind: Some("interrupted".into()),
            error: Some("The action ended without a saved journal result. Refresh the repository; the recorded Git outcome is unknown.".into()),
        }
    }

    fn write(&self, db: &Connection, session: &str, id: &str) -> Result<()> {
        db.execute(
            "UPDATE operations SET status=?1,finished_at=?2,duration_ms=?3,outcome=?4,error_kind=?5,error=?6,bytes=bytes+?7
            WHERE id=?8 AND session=?9 AND status IN ('queued','running')",
            params![
                self.status,
                self.finished_at,
                self.duration_ms,
                self.outcome,
                self.kind,
                self.error,
                self.error.as_ref().map_or(0, String::len) as i64,
                id,
                session
            ],
        )
        .map_err(diagnostic)?;
        Ok(())
    }
}

impl Journal {
    pub fn open(dir: &Path) -> Result<Arc<Self>> {
        fs::create_dir_all(dir.join("sessions")).map_err(diagnostic)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(diagnostic)?;
        }
        let lock = tempfile::Builder::new().prefix("session-").suffix(".lock").tempfile_in(dir.join("sessions")).map_err(diagnostic)?;
        lock.as_file().try_lock_exclusive().map_err(diagnostic)?;
        let session = lock.path().file_name().unwrap().to_string_lossy().into_owned();
        let path = dir.join("operations.sqlite3");
        let db = Connection::open(&path).map_err(diagnostic)?;
        db.busy_timeout(Duration::from_secs(3)).map_err(diagnostic)?;
        let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0)).map_err(diagnostic)?;
        if version > 1 {
            return Err("This operation journal was created by a newer app version.".into());
        }
        db.execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS operations(
                id TEXT PRIMARY KEY, session TEXT NOT NULL, repo TEXT NOT NULL, repository_key TEXT NOT NULL,
                command TEXT NOT NULL, search_text TEXT NOT NULL, status TEXT NOT NULL, requested_at INTEGER NOT NULL, started_at INTEGER,
                finished_at INTEGER, wait_ms INTEGER, duration_ms INTEGER, before_head TEXT, after_head TEXT,
                outcome TEXT, error_kind TEXT, error TEXT, truncated INTEGER NOT NULL DEFAULT 0,
                output_bytes INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0);
            CREATE INDEX IF NOT EXISTS operations_time ON operations(requested_at DESC,id DESC);
            CREATE INDEX IF NOT EXISTS operations_repository ON operations(repository_key,requested_at DESC);
            CREATE TABLE IF NOT EXISTS commands(
                operation TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE, sequence INTEGER NOT NULL,
                cwd TEXT NOT NULL, args TEXT NOT NULL, started_at INTEGER NOT NULL, duration_ms INTEGER, exit_code INTEGER,
                stdout TEXT NOT NULL DEFAULT '', stderr TEXT NOT NULL DEFAULT '', output_omitted INTEGER NOT NULL,
                truncated INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(operation,sequence));
            PRAGMA user_version=1;",
        )
        .map_err(diagnostic)?;
        db.execute("INSERT INTO sessions(id) VALUES(?1)", [&session]).map_err(diagnostic)?;
        let journal = Arc::new(Self { db: Mutex::new(db), completions: Mutex::default(), path, session, _lock: lock, next: AtomicU64::new(0) });
        journal.recover()?;
        journal.prune()?;
        Ok(journal)
    }

    fn recover(&self) -> Result<()> {
        let db = self.db.lock();
        let sessions = db
            .prepare("SELECT id FROM sessions WHERE id != ?1")
            .map_err(diagnostic)?
            .query_map([&self.session], |r| r.get::<_, String>(0))
            .map_err(diagnostic)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(diagnostic)?;
        for session in sessions {
            if !session.starts_with("session-") || !session.ends_with(".lock") || Path::new(&session).components().count() != 1 {
                continue;
            }
            let path = self.path.parent().unwrap().join("sessions").join(&session);
            let guard = match OpenOptions::new().read(true).write(true).open(&path) {
                Ok(file) => match file.try_lock_exclusive() {
                    Ok(()) => Some(file),
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.raw_os_error() == fs2::lock_contended_error().raw_os_error() => continue,
                    Err(e) => return Err(diagnostic(e)),
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(diagnostic(e)),
            };
            db.execute("UPDATE operations SET status='interrupted', finished_at=?1, error_kind='interrupted',
                error='The app session ended before recording a result. Git may have continued; its outcome is unknown. Refresh the repository before another action.'
                WHERE session=?2 AND status IN ('queued','running')", params![now(), session]).map_err(diagnostic)?;
            db.execute("DELETE FROM sessions WHERE id=?1", [&session]).map_err(diagnostic)?;
            drop(guard);
            let _ = fs::remove_file(path);
        }
        Ok(())
    }

    pub fn begin(self: &Arc<Self>, root: &Path, command: &str) -> Result<Operation> {
        let id = format!("{}-{}", self.session, self.next.fetch_add(1, Ordering::Relaxed));
        let root = root.to_string_lossy().into_owned();
        let key = operations::repository_key(Path::new(&root)).to_string_lossy().into_owned();
        let search = format!("{} {}", command.replace('_', " "), root).to_lowercase();
        // Lifecycle changes and retry take this lock before the database lock, so a
        // newly inserted action cannot be mistaken for a failed completion.
        let mut completions = self.completions.lock();
        self.db
            .lock()
            .execute(
                "INSERT INTO operations(id,session,repo,repository_key,command,search_text,status,requested_at,bytes)
            VALUES(?1,?2,?3,?4,?5,?6,'queued',?7,?8)",
                params![id, self.session, root, key, command, search, now(), (root.len() + key.len() + command.len() + search.len()) as i64],
            )
            .map_err(diagnostic)?;
        completions.active.insert(id.clone());
        drop(completions);
        let context = Arc::new(Context { store: self.clone(), id, count: AtomicU64::new(0), closed: AtomicBool::new(false) });
        CURRENT.with(|c| c.borrow_mut().push(context.clone()));
        Ok(Operation { context, created: Instant::now() })
    }

    fn complete(&self, id: &str, terminal: Terminal) -> Result<()> {
        let mut completions = self.completions.lock();
        completions.active.remove(id);
        let result = terminal.write(&self.db.lock(), &self.session, id);
        if result.is_err() && completions.pending.len() < MAX_ENTRIES as usize {
            // Only sanitized, bounded terminal metadata is retained, never Git work.
            completions.pending.insert(id.to_owned(), terminal);
        }
        result
    }

    fn retry(&self) -> Result<()> {
        let mut completions = self.completions.lock();
        let mut db = self.db.lock();
        let tx = db.transaction().map_err(diagnostic)?;
        tx.execute("UPDATE sessions SET id=id WHERE id=?1", [&self.session]).map_err(diagnostic)?;
        let unfinished = tx
            .prepare("SELECT id FROM operations WHERE session=?1 AND status IN ('queued','running')")
            .map_err(diagnostic)?
            .query_map([&self.session], |r| r.get::<_, String>(0))
            .map_err(diagnostic)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(diagnostic)?;
        for id in unfinished {
            if !completions.active.contains(&id) {
                let terminal = completions.pending.get(&id).cloned().unwrap_or_else(Terminal::unknown);
                terminal.write(&tx, &self.session, &id)?;
            }
        }
        // A failed retry leaves the cache intact. Missing/previously completed rows
        // need no retry; all remaining cached results were saved in this transaction.
        tx.commit().map_err(diagnostic)?;
        completions.pending.clear();
        Ok(())
    }

    fn prune(&self) -> Result<()> {
        let db = self.db.lock();
        db.execute(
            "DELETE FROM operations WHERE id IN (
            SELECT id FROM (SELECT id,finished_at,ROW_NUMBER() OVER(ORDER BY requested_at DESC,id DESC) AS n,
            SUM(bytes) OVER(ORDER BY requested_at DESC,id DESC) AS size FROM operations WHERE status NOT IN ('queued','running'))
            WHERE n>?1 OR size>?2 OR finished_at<?3)",
            params![MAX_ENTRIES, MAX_BYTES, now() - RETENTION_MS],
        )
        .map_err(diagnostic)?;
        // Reuse freed pages; incremental vacuum avoids a full blocking VACUUM.
        db.execute_batch("PRAGMA incremental_vacuum(128);").map_err(diagnostic)?;
        Ok(())
    }

    pub fn list(&self, filter: &Filter, limit: usize) -> Result<Page> {
        self.recover()?;
        self.prune()?;
        let key = filter.repo.as_ref().map(|r| operations::repository_key(Path::new(r)).to_string_lossy().into_owned());
        let search = filter.search.as_deref().unwrap_or("").trim().to_lowercase();
        let db = self.db.lock();
        let condition = "(?1 IS NULL OR repository_key=?1) AND (?2 IS NULL OR status=?2) AND
            (?3='' OR instr(search_text || ' ' || COALESCE(error_kind,''),?3)>0) AND
            (?4 IS NULL OR requested_at>=?4) AND (?5 IS NULL OR requested_at<?5)";
        let total = db
            .query_row(&format!("SELECT COUNT(*) FROM operations WHERE {condition}"), params![key, filter.status, search, filter.since, filter.until], |r| {
                r.get(0)
            })
            .map_err(diagnostic)?;
        let cursor: Option<(i64, String)> = filter.before.as_ref().map(|s| serde_json::from_str(s).map_err(diagnostic)).transpose()?;
        let mut statement = db
            .prepare(&format!(
                "SELECT id,repo,repository_key,command,status,requested_at,started_at,finished_at,wait_ms,duration_ms,
            before_head,after_head,outcome,error_kind,error,truncated FROM operations WHERE {condition}
            AND (?6 IS NULL OR (requested_at,id)<(?6,?7)) ORDER BY requested_at DESC,id DESC LIMIT ?8"
            ))
            .map_err(diagnostic)?;
        let mut entries = statement
            .query_map(
                params![
                    key,
                    filter.status,
                    search,
                    filter.since,
                    filter.until,
                    cursor.as_ref().map(|c| c.0),
                    cursor.as_ref().map(|c| &c.1),
                    (limit.clamp(1, 200) + 1) as i64
                ],
                row_entry,
            )
            .map_err(diagnostic)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(diagnostic)?;
        let next = if entries.len() > limit.clamp(1, 200) {
            entries.pop();
            entries.last().map(|e| serde_json::to_string(&(e.requested_at, &e.id)).unwrap())
        } else {
            None
        };
        Ok(Page { entries, next, total })
    }

    pub fn detail(&self, id: &str) -> Result<Detail> {
        read_detail(&self.db.lock(), id)
    }

    pub fn clear(&self, filter: &Filter) -> Result<usize> {
        let key = filter.repo.as_ref().map(|r| operations::repository_key(Path::new(r)).to_string_lossy().into_owned());
        let search = filter.search.as_deref().unwrap_or("").trim().to_lowercase();
        let db = self.db.lock();
        let deleted = db
            .execute(
                "DELETE FROM operations WHERE status NOT IN ('queued','running') AND (?1 IS NULL OR repository_key=?1)
            AND (?2 IS NULL OR status=?2) AND (?3='' OR instr(search_text || ' ' || COALESCE(error_kind,''),?3)>0)
            AND (?4 IS NULL OR requested_at>=?4) AND (?5 IS NULL OR requested_at<?5)",
                params![key, filter.status, search, filter.since, filter.until],
            )
            .map_err(diagnostic)?;
        db.execute_batch("PRAGMA incremental_vacuum(128);").map_err(diagnostic)?;
        Ok(deleted)
    }

    pub fn export(&self, filter: &Filter, destination: &Path) -> Result<usize> {
        self.recover()?;
        self.prune()?;
        let key = filter.repo.as_ref().map(|r| operations::repository_key(Path::new(r)).to_string_lossy().into_owned());
        let search = filter.search.as_deref().unwrap_or("").trim().to_lowercase();
        let mut connection = Connection::open_with_flags(&self.path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(diagnostic)?;
        connection.busy_timeout(Duration::from_secs(3)).map_err(diagnostic)?;
        let transaction = connection.transaction().map_err(diagnostic)?;
        let condition = "(?1 IS NULL OR repository_key=?1) AND (?2 IS NULL OR status=?2) AND
            (?3='' OR instr(search_text || ' ' || COALESCE(error_kind,''),?3)>0) AND
            (?4 IS NULL OR requested_at>=?4) AND (?5 IS NULL OR requested_at<?5)";
        let total: i64 = transaction
            .query_row(&format!("SELECT COUNT(*) FROM operations WHERE {condition}"), params![key, filter.status, search, filter.since, filter.until], |r| {
                r.get(0)
            })
            .map_err(diagnostic)?;
        let ids = transaction
            .prepare(&format!("SELECT id FROM operations WHERE {condition} ORDER BY requested_at DESC,id DESC LIMIT ?6"))
            .map_err(diagnostic)?
            .query_map(params![key, filter.status, search, filter.since, filter.until, MAX_ENTRIES], |r| r.get::<_, String>(0))
            .map_err(diagnostic)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(diagnostic)?;
        let snapshot = ids.iter().map(|id| read_detail(&transaction, id)).collect::<Result<Vec<_>>>()?;
        transaction.commit().map_err(diagnostic)?;
        // Never export over the live journal (including a symlink to the database).
        let parent = destination.parent().ok_or("Choose a destination file.")?;
        let parent = fs::canonicalize(parent).map_err(diagnostic)?;
        let journal_dir = fs::canonicalize(self.path.parent().unwrap()).map_err(diagnostic)?;
        if parent.starts_with(&journal_dir) || fs::canonicalize(destination).is_ok_and(|p| p.starts_with(&journal_dir)) {
            return Err("Choose a location outside the live operation journal.".into());
        }
        let payload = serde_json::json!({"format":"revqora-operation-log","version":1,"exportedAt":now(),"matchingEntries":total,"truncated":total>snapshot.len() as i64,"operations":snapshot});
        let bytes = serde_json::to_vec_pretty(&payload).map_err(diagnostic)?;
        let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(diagnostic)?;
        use std::io::Write;
        temp.write_all(&bytes).map_err(diagnostic)?;
        temp.as_file().sync_all().map_err(diagnostic)?;
        temp.persist(destination).map_err(diagnostic)?;
        Ok(snapshot.len())
    }
}

fn read_detail(db: &Connection, id: &str) -> Result<Detail> {
    let entry = db
        .query_row(
            "SELECT id,repo,repository_key,command,status,requested_at,started_at,finished_at,wait_ms,duration_ms,
            before_head,after_head,outcome,error_kind,error,truncated FROM operations WHERE id=?1",
            [id],
            row_entry,
        )
        .optional()
        .map_err(diagnostic)?
        .ok_or_else(|| "This operation is no longer in the journal.".to_owned())?;
    let steps = db.prepare("SELECT sequence,cwd,args,started_at,duration_ms,exit_code,stdout,stderr,output_omitted,truncated FROM commands WHERE operation=?1 ORDER BY sequence").map_err(diagnostic)?
            .query_map([id], |r| Ok(Step { sequence:r.get(0)?,cwd:r.get(1)?,args:serde_json::from_str(&r.get::<_,String>(2)?).unwrap_or_default(),started_at:r.get(3)?,duration_ms:r.get(4)?,exit_code:r.get(5)?,stdout:r.get(6)?,stderr:r.get(7)?,output_omitted:r.get(8)?,truncated:r.get(9)? }))
            .map_err(diagnostic)?.collect::<rusqlite::Result<Vec<_>>>().map_err(diagnostic)?;
    Ok(Detail { entry, steps })
}

fn row_entry(r: &rusqlite::Row<'_>) -> rusqlite::Result<Entry> {
    Ok(Entry {
        id: r.get(0)?,
        repo: r.get(1)?,
        repository_key: r.get(2)?,
        command: r.get(3)?,
        status: r.get(4)?,
        requested_at: r.get(5)?,
        started_at: r.get(6)?,
        finished_at: r.get(7)?,
        wait_ms: r.get(8)?,
        duration_ms: r.get(9)?,
        before_head: r.get(10)?,
        after_head: r.get(11)?,
        outcome: r.get(12)?,
        error_kind: r.get(13)?,
        error: r.get(14)?,
        truncated: r.get(15)?,
    })
}

struct Context {
    store: Arc<Journal>,
    id: String,
    count: AtomicU64,
    closed: AtomicBool,
}
pub struct Operation {
    context: Arc<Context>,
    created: Instant,
}

impl Operation {
    pub fn phase(&self, phase: &str, root: &Path) {
        if phase != "running" {
            return;
        }
        let stamp = now();
        let wait = self.created.elapsed().as_millis() as i64;
        let head = head(root);
        let result =
            self.context.store.db.lock().execute(
                "UPDATE operations SET status='running',started_at=?1,wait_ms=?2,before_head=?3 WHERE id=?4",
                params![stamp, wait, head, self.context.id],
            );
        if let Err(e) = result {
            warn(e);
        }
    }
    pub fn after(&self, root: &Path) {
        let head = head(root);
        let key = operations::repository_key(root).to_string_lossy().into_owned();
        if let Err(e) =
            self.context.store.db.lock().execute("UPDATE operations SET after_head=?1,repository_key=?2 WHERE id=?3", params![head, key, self.context.id])
        {
            warn(e);
        }
    }
    pub fn finish<T: Serialize>(&self, result: &std::result::Result<T, GitError>) {
        if self.context.closed.swap(true, Ordering::Relaxed) {
            return;
        }
        let outcome = result.as_ref().ok().and_then(|value| serde_json::to_value(value).ok()).and_then(|v| {
            v.get("status")
                .and_then(|s| s.as_str())
                .filter(|s| matches!(*s, "done" | "conflicts" | "pending" | "stopped" | "upToDate" | "fastForward"))
                .map(str::to_owned)
        });
        let attention = outcome.as_deref().is_some_and(|s| matches!(s, "conflicts" | "pending" | "stopped"));
        let status = if result.is_err() {
            "failed"
        } else if attention {
            "attention"
        } else {
            "succeeded"
        };
        let error = result.as_ref().err().map(|e| redact::bounded(&redact::text(&e.message), 2048).0);
        let kind = result.as_ref().err().map(|e| redact::bounded(&redact::text(&e.kind), 128).0);
        let update = self.context.store.complete(
            &self.context.id,
            Terminal { status, finished_at: now(), duration_ms: Some(self.created.elapsed().as_millis() as i64), outcome, kind, error },
        );
        if let Err(e) = update {
            warn(e);
        }
        if let Err(e) = self.context.store.prune() {
            warn(e);
        }
    }
}

fn head(root: &Path) -> Option<String> {
    // Diagnostic reads are inside the existing repository gate and are not traced.
    suspend(|| repo::head(root).ok().and_then(|h| serde_json::to_string(&h).ok()))
}

impl Drop for Operation {
    fn drop(&mut self) {
        CURRENT.with(|c| c.borrow_mut().retain(|s| s.id != self.context.id));
        if !self.context.closed.swap(true, Ordering::Relaxed) {
            let result = self.context.store.complete(&self.context.id, Terminal::unknown());
            if let Err(e) = result {
                warn(e);
            }
        }
    }
}

fn suspend<T>(f: impl FnOnce() -> T) -> T {
    struct Restore(Vec<Arc<Context>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            CURRENT.with(|c| *c.borrow_mut() = std::mem::take(&mut self.0));
        }
    }
    let saved = CURRENT.with(|c| std::mem::take(&mut *c.borrow_mut()));
    let _restore = Restore(saved);
    f()
}

pub struct Command {
    context: Arc<Context>,
    sequence: i64,
    args: Vec<String>,
    started: Instant,
    finished: bool,
}
impl Command {
    pub fn finish(&mut self, code: Option<i32>, stdout: &[u8], stderr: &str) {
        if self.finished {
            return;
        }
        self.finished = true;
        let allowed = redact::output_allowed(&self.args);
        let db = self.context.store.db.lock();
        let used: i64 = db.query_row("SELECT output_bytes FROM operations WHERE id=?1", [&self.context.id], |r| r.get(0)).unwrap_or(OUTPUT_BUDGET);
        let remaining = (OUTPUT_BUDGET - used).max(0) as usize;
        let (stdout, a) = if allowed { redact::bounded(&redact::text(&String::from_utf8_lossy(stdout)), remaining.min(8192)) } else { (String::new(), false) };
        let (stderr, b) = if allowed || self.args.first().is_some_and(|s| s == "commit") {
            redact::bounded(&redact::text(stderr), remaining.saturating_sub(stdout.len()).min(8192))
        } else {
            (String::new(), false)
        };
        let size = stdout.len() + stderr.len();
        let result = db
            .execute(
                "UPDATE commands SET duration_ms=?1,exit_code=?2,stdout=?3,stderr=?4,truncated=truncated OR ?5 WHERE operation=?6 AND sequence=?7",
                params![self.started.elapsed().as_millis() as i64, code, stdout, stderr, a || b, self.context.id, self.sequence],
            )
            .and_then(|_| {
                db.execute(
                    "UPDATE operations SET output_bytes=output_bytes+?1,bytes=bytes+?1,truncated=truncated OR ?2 WHERE id=?3",
                    params![size as i64, a || b, self.context.id],
                )
            });
        if let Err(e) = result {
            warn(e);
        }
    }
}
impl Drop for Command {
    fn drop(&mut self) {
        if !self.finished {
            self.finish(None, &[], "Git process ended without a captured result.");
        }
    }
}

pub fn command(root: &Path, args: &[String]) -> Option<Command> {
    let context = CURRENT.with(|c| c.borrow().last().cloned())?;
    if context.closed.load(Ordering::Relaxed) {
        return None;
    }
    let sequence = context.count.fetch_add(1, Ordering::Relaxed);
    if sequence >= MAX_COMMANDS {
        if let Err(e) = context.store.db.lock().execute("UPDATE operations SET truncated=1 WHERE id=?1", [&context.id]) {
            warn(e);
        }
        return None;
    }
    let mut safe = redact::args(args);
    let truncated = args.len() > 48 || args.iter().any(|arg| arg.len() > 1024);
    if args.len() > 48 {
        safe.push(format!("[{} additional arguments omitted]", args.len() - 48));
    }
    let json = serde_json::to_string(&safe).ok()?;
    let cwd = root.to_string_lossy().into_owned();
    let db = context.store.db.lock();
    let result = db
        .execute(
            "INSERT INTO commands(operation,sequence,cwd,args,started_at,output_omitted,truncated) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![context.id, sequence as i64, cwd, json, now(), !redact::output_allowed(args), truncated],
        )
        .and_then(|_| {
            db.execute(
                "UPDATE operations SET bytes=bytes+?1,truncated=truncated OR ?2 WHERE id=?3",
                params![(json.len() + cwd.len()) as i64, truncated, context.id],
            )
        });
    if let Err(e) = result {
        warn(e);
        return None;
    }
    drop(db);
    Some(Command { context, sequence: sequence as i64, args: args.to_vec(), started: Instant::now(), finished: false })
}

pub fn initialize(dir: Option<&Path>) {
    DIRECTORY.get_or_init(|| dir.map(Path::to_owned));
    if let Err(e) = retry() {
        warn(e);
    }
}
pub fn store() -> Result<Arc<Journal>> {
    STORE.get().and_then(|s| s.lock().clone()).ok_or_else(|| WARNING.lock().clone().unwrap_or_else(|| "Operation journal is unavailable.".into()))
}
pub fn begin(root: &Path, command: &str) -> Option<Operation> {
    match store().and_then(|s| s.begin(root, command)) {
        Ok(op) => Some(op),
        Err(e) => {
            warn(e);
            None
        }
    }
}
pub fn health() -> Health {
    let store = store().ok();
    Health {
        available: store.is_some(),
        warning: WARNING.lock().clone(),
        path: store.map(|s| s.path.to_string_lossy().into_owned()),
        retention_days: 30,
        max_entries: MAX_ENTRIES,
    }
}
pub fn retry() -> Result<()> {
    let mut current = STORE.get_or_init(|| Mutex::new(None)).lock();
    if let Some(store) = current.as_ref() {
        store.retry()?;
    } else {
        let dir = DIRECTORY.get().and_then(Option::as_ref).ok_or("The app data folder is unavailable.")?;
        *current = Some(Journal::open(dir)?);
    }
    *WARNING.lock() = None;
    Ok(())
}

pub fn record<T: Serialize>(
    root: &Path,
    command: &str,
    notify: impl Fn(),
    f: impl FnOnce() -> crate::git::runner::GitResult<T>,
) -> crate::git::runner::GitResult<T> {
    let log = begin(root, command);
    notify();
    if let Some(log) = &log {
        log.phase("running", root);
    }
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let result = f();
        if let Some(log) = &log {
            log.after(root);
        }
        result
    }))
    .unwrap_or_else(|_| Err(GitError::new("The operation failed unexpectedly. Refresh the repository before another action.").kind("operation-failed")));
    if let Some(log) = &log {
        log.finish(&result);
    }
    notify();
    result
}

#[cfg(test)]
mod tests;
