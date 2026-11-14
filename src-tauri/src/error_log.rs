//! Application errors, stored separately from the Git operation journal.
use std::{path::Path, time::Duration};

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::journal::{now, redact};

const RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES: i64 = 2000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    id: i64,
    timestamp: i64,
    source: String,
    code: String,
    message: String,
    count: i64,
}

fn open(directory: &Path) -> rusqlite::Result<Connection> {
    let db = Connection::open(directory.join("errors.sqlite3"))?;
    db.busy_timeout(Duration::from_secs(2))?;
    db.pragma_update(None, "secure_delete", true)?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS errors (
            id INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL, source TEXT NOT NULL,
            code TEXT NOT NULL, message TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1
        );",
    )?;
    Ok(db)
}

fn prune(db: &Connection, timestamp: i64) -> rusqlite::Result<()> {
    db.execute("DELETE FROM errors WHERE timestamp < ?1", [timestamp.saturating_sub(RETENTION_MS)])?;
    Ok(())
}

fn append(db: &mut Connection, timestamp: i64, source: &str, code: &str, message: &str) -> rusqlite::Result<()> {
    let clean = |text, limit| redact::bounded(&redact::text(text), limit).0;
    let (source, code, message) = (clean(source, 96), clean(code, 96), clean(message, 4096));
    let transaction = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    prune(&transaction, timestamp)?;
    // A failing watcher may report the same error many times a second.
    let updated = transaction.execute(
        "UPDATE errors SET count = count + 1
         WHERE id = (SELECT id FROM errors WHERE source = ?1 AND code = ?2 AND message = ?3
                     AND timestamp >= ?4 ORDER BY id DESC LIMIT 1)",
        params![source, code, message, timestamp.saturating_sub(60_000)],
    )?;
    if updated == 0 {
        transaction.execute("INSERT INTO errors(timestamp, source, code, message) VALUES (?1, ?2, ?3, ?4)", params![timestamp, source, code, message])?;
        transaction.execute("DELETE FROM errors WHERE id <= (SELECT id FROM errors ORDER BY id DESC LIMIT 1 OFFSET ?1)", [MAX_ENTRIES])?;
    }
    transaction.commit()
}

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

pub fn record(source: &str, code: &str, message: &str) -> Result<()> {
    record_at(&crate::portable::runtime_dir()?, source, code, message)
}

pub fn record_at(directory: &Path, source: &str, code: &str, message: &str) -> Result<()> {
    std::fs::create_dir_all(directory)?;
    append(&mut open(directory)?, now(), source, code, message)?;
    Ok(())
}

pub fn list() -> Result<Vec<Entry>> {
    let db = open(&crate::portable::runtime_dir()?)?;
    prune(&db, now())?;
    let mut statement = db.prepare("SELECT id, timestamp, source, code, message, count FROM errors ORDER BY timestamp DESC, id DESC")?;
    let rows = statement.query_map([], |row| {
        Ok(Entry { id: row.get(0)?, timestamp: row.get(1)?, source: row.get(2)?, code: row.get(3)?, message: row.get(4)?, count: row.get(5)? })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn maintain() {
    if let Ok(directory) = crate::portable::runtime_dir() {
        if directory.join("errors.sqlite3").is_file() {
            let _ = open(&directory).and_then(|db| prune(&db, now()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_persist_expire_and_hide_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = open(dir.path()).unwrap();
        append(&mut db, 1, "startup", "io", "expired").unwrap();
        let timestamp = RETENTION_MS + 2;
        let message = "Open https://person:private@example.test/ failed (os error 5)";
        append(&mut db, timestamp, "update", "io", message).unwrap();
        append(&mut db, timestamp + 1, "update", "io", message).unwrap();
        drop(db);
        let db = open(dir.path()).unwrap();
        let row: (i64, i64, String) =
            db.query_row("SELECT count(*), max(count), message FROM errors", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap();
        assert_eq!((row.0, row.1), (1, 2));
        assert!(row.2.contains("[redacted]") && !row.2.contains("private") && row.2.contains("os error 5"));
        prune(&db, timestamp + RETENTION_MS + 2).unwrap();
        assert_eq!(db.query_row("SELECT count(*) FROM errors", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    }
}
