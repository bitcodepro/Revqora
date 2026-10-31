use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{io::Write, sync::Arc, time::Duration};
pub(crate) static SERIAL: Mutex<()> = Mutex::new(());
#[derive(Clone)]
pub(crate) struct Request {
    pub(crate) method: String,
    pub(crate) path: String,
    pub(crate) accept: String,
    pub(crate) body: Value,
}
pub(crate) struct Http {
    pub(crate) url: String,
    pub(crate) seen: Arc<Mutex<Vec<Request>>>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Http {
    pub(crate) fn new(reply: impl Fn(&Request) -> (u16, String, String) + Send + 'static) -> Self {
        use std::{
            io::{BufRead, BufReader, Read},
            net::TcpListener,
            sync::atomic::Ordering,
            thread,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let seen = Arc::new(Mutex::new(vec![]));
        let capture = seen.clone();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let done = stop.clone();
        let handle = thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                let (mut stream, _) = match listener.accept() {
                    Ok(s) => s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(_) => break,
                };
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut reader = BufReader::new(&mut stream);
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
                let words = line.split_whitespace().map(str::to_owned).collect::<Vec<_>>();
                if words.len() < 2 {
                    continue;
                }
                let mut r = Request { method: words[0].clone(), path: words[1].clone(), accept: String::new(), body: Value::Null };
                let mut size = 0;
                loop {
                    line.clear();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some((key, value)) = line.split_once(':') {
                        match key.to_ascii_lowercase().as_str() {
                            "content-length" => size = value.trim().parse().unwrap(),
                            "accept" => r.accept = value.trim().into(),
                            _ => {}
                        }
                    }
                }
                let mut body = vec![0; size];
                reader.read_exact(&mut body).unwrap();
                drop(reader);
                if !body.is_empty() {
                    r.body = serde_json::from_slice(&body).unwrap();
                }
                capture.lock().push(r.clone());
                let (code, headers, body) = reply(&r);
                let response = format!("HTTP/1.1 {code} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}", body.len());
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.shutdown(std::net::Shutdown::Write);
            }
        });
        Self { url, seen, stop, thread: Some(handle) }
    }
}
impl Drop for Http {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        self.thread.take().unwrap().join().unwrap();
    }
}
pub(crate) const PATCH:&str="diff --git a/old.txt b/new.txt\nsimilarity index 60%\nrename from old.txt\nrename to new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1 +1 @@\n-before\n+after\n";
pub(crate) fn metadata(kind: &str, title: &str, body: &str, base: &str, stamp: u64) -> Value {
    let a = "a".repeat(40);
    let b = "b".repeat(40);
    match kind {
        "github" => {
            json!({"number":7,"title":title,"body":body,"updated_at":stamp.to_string(),"head":{"ref":"topic","sha":a},"base":{"ref":base,"sha":b},"user":{"login":"author"},"state":"open","changed_files":1})
        }
        "gitlab" => {
            json!({"iid":7,"title":title,"description":body,"updated_at":stamp.to_string(),"source_branch":"topic","target_branch":base,"sha":a,"diff_refs":{"head_sha":a,"start_sha":b,"base_sha":"c".repeat(40)},"author":{"username":"author"},"state":"opened","changes_count":"1"})
        }
        "bitbucket" => {
            json!({"id":7,"title":title,"description":body,"updated_on":stamp.to_string(),"source":{"branch":{"name":"topic"},"commit":{"hash":a}},"destination":{"branch":{"name":base},"commit":{"hash":b}},"author":{"display_name":"author"},"state":"OPEN"})
        }
        "bitbucket-server" => {
            json!({"id":7,"version":stamp,"title":title,"description":body,"updatedDate":stamp,"fromRef":{"displayId":"topic","id":"refs/heads/topic","latestCommit":a},"toRef":{"displayId":base,"id":format!("refs/heads/{base}"),"latestCommit":b,"repository":{"slug":"repo","project":{"key":"team"}}},"author":{"user":{"displayName":"author"}},"state":"OPEN"})
        }
        _ => {
            json!({"pullRequestId":7,"title":title,"description":body,"sourceRefName":"refs/heads/topic","targetRefName":format!("refs/heads/{base}"),"lastMergeSourceCommit":{"commitId":a},"lastMergeTargetCommit":{"commitId":b},"createdBy":{"displayName":"author"},"status":"active","creationDate":"2026-01-01"})
        }
    }
}
