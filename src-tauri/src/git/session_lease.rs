//! Explicitly unlock before closing: fork/dup can keep an open-file description
//! alive after our File is dropped. CLOEXEC only closes a child's copy at exec.
use fs2::FileExt;
use std::{fs::File, io};

#[derive(Debug)]
pub(super) struct SessionLease {
    file: File,
    released: bool,
}
impl SessionLease {
    pub(super) fn acquire(file: File) -> io::Result<Self> {
        // Construct the guard only after success. Dropping a failed probe must
        // never unlock another owner's lease.
        FileExt::try_lock_exclusive(&file)?;
        Ok(Self { file, released: false })
    }
    pub(super) fn release(mut self) -> io::Result<()> {
        FileExt::unlock(&self.file)?;
        self.released = true;
        Ok(())
    }
}
impl Drop for SessionLease {
    fn drop(&mut self) {
        if !self.released {
            // Covers probes, early returns and unwinding. The normal worker
            // path uses release() so an unlock error is reported to the user.
            let _ = FileExt::unlock(&self.file);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs::OpenOptions, path::Path};
    fn open(path: &Path) -> File {
        OpenOptions::new().create(true).truncate(false).read(true).write(true).open(path).unwrap()
    }
    #[test]
    fn failed_probes_do_not_unlock_the_current_owner() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.lock");
        let owner = SessionLease::acquire(open(&path)).unwrap();
        assert!(SessionLease::acquire(open(&path)).is_err());
        assert!(SessionLease::acquire(open(&path)).is_err());
        owner.release().unwrap();
        SessionLease::acquire(open(&path)).unwrap().release().unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn raw_file_close_keeps_the_old_lock_while_a_duplicate_exists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.lock");
        let owner = open(&path);
        FileExt::try_lock_exclusive(&owner).unwrap();
        let inherited = owner.try_clone().unwrap();
        drop(owner);
        assert!(SessionLease::acquire(open(&path)).is_err(), "Fixture must reproduce close-only release failure");
        FileExt::unlock(&inherited).unwrap();
        SessionLease::acquire(open(&path)).unwrap().release().unwrap();
        drop(inherited);
    }
    #[cfg(unix)]
    #[test]
    fn explicit_release_and_drop_unlock_before_duplicate_descriptors_close() {
        for explicit in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("session.lock");
            let owner = SessionLease::acquire(open(&path)).unwrap();
            let inherited = owner.file.try_clone().unwrap();
            assert!(SessionLease::acquire(open(&path)).is_err());
            if explicit {
                owner.release().unwrap();
            } else {
                drop(owner);
            }
            let next = SessionLease::acquire(open(&path)).expect("Finished owner retained its flock through an inherited descriptor");
            drop(inherited);
            assert!(SessionLease::acquire(open(&path)).is_err(), "Closing the old copy must not unlock the new owner's separate lease");
            drop(next);
            SessionLease::acquire(open(&path)).unwrap().release().unwrap();
        }
    }
    #[cfg(unix)]
    #[test]
    fn a_child_paused_between_fork_and_exec_cannot_retain_a_finished_lease() {
        use std::{
            io::{Read, Write},
            os::{
                fd::AsRawFd,
                unix::{net::UnixStream, process::CommandExt},
            },
            process::Command,
            thread,
            time::Duration,
        };
        // The child performs only async-signal-safe syscalls before exec. A
        // socket handshake holds its inherited descriptor deterministically;
        // no timing loop, scheduling assumption or descendant timeout is used.
        struct PausedChild {
            parent: UnixStream,
            worker: Option<thread::JoinHandle<io::Result<std::process::ExitStatus>>>,
        }
        impl Drop for PausedChild {
            fn drop(&mut self) {
                let _ = self.parent.write_all(&[1]);
                if let Some(worker) = self.worker.take() {
                    let _ = worker.join();
                }
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.lock");
        let owner = SessionLease::acquire(open(&path)).unwrap();
        let flags = unsafe { libc::fcntl(owner.file.as_raw_fd(), libc::F_GETFD) };
        assert!(flags >= 0 && flags & libc::FD_CLOEXEC != 0, "The regression must retain the usual CLOEXEC protection");
        let (parent, child) = UnixStream::pair().unwrap();
        parent.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        child.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let worker = thread::spawn(move || {
            let fd = child.as_raw_fd();
            let mut command = Command::new("/bin/sh");
            command.args(["-c", "exit 0"]);
            unsafe {
                command.pre_exec(move || {
                    let mut byte = 1u8;
                    if libc::write(fd, (&byte as *const u8).cast(), 1) != 1 {
                        return Err(io::Error::last_os_error());
                    }
                    if libc::read(fd, (&mut byte as *mut u8).cast(), 1) != 1 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            let mut process = command.spawn()?;
            drop(child);
            process.wait()
        });
        let mut paused = PausedChild { parent, worker: Some(worker) };
        paused.parent.read_exact(&mut [0]).unwrap();
        drop(owner);
        let next = SessionLease::acquire(open(&path)).expect("A pre-exec child retained the finished session's flock");
        assert!(SessionLease::acquire(open(&path)).is_err());
        paused.parent.write_all(&[1]).unwrap();
        assert!(paused.worker.take().unwrap().join().unwrap().unwrap().success());
        drop(next);
        SessionLease::acquire(open(&path)).unwrap().release().unwrap();
    }
}
