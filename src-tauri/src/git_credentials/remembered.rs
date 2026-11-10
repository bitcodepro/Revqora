use super::{now, Key, LIMIT};
use crate::{git::atomic_file, windows_secret::dpapi};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};
use zeroize::{Zeroize, Zeroizing};

const MAX_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Deserialize, Serialize)]
pub(super) struct Token {
    pub key: Key,
    pub password: String,
    pub expires: Option<u64>,
    pub api_email: Option<String>,
}

impl Drop for Token {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

pub(super) struct Store(PathBuf);

impl Store {
    pub fn for_repo(repo: &Path) -> io::Result<Self> {
        Ok(Self::in_dir(&crate::portable::runtime_dir()?.join("git-credentials"), repo))
    }

    fn in_dir(dir: &Path, repo: &Path) -> Self {
        Self(dir.join(format!("{:x}.bin", Sha256::digest(repo.as_os_str().as_encoded_bytes()))))
    }

    pub fn read(&self) -> io::Result<Vec<Token>> {
        let file = match File::open(&self.0) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let mut bytes = Vec::new();
        file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err(io::Error::other("Saved Git token file exceeds its size limit."));
        }
        let decoded = dpapi(&bytes, false)?;
        serde_json::from_slice(&decoded).map_err(|_| io::Error::other("Saved Git token file is invalid."))
    }

    fn write(&self, update: impl FnOnce(&mut Vec<Token>)) -> io::Result<()> {
        let dir = self.0.parent().ok_or_else(|| io::Error::other("Missing Git token directory."))?;
        fs::create_dir_all(dir)?;
        let lock = OpenOptions::new().create(true).truncate(false).write(true).open(self.0.with_extension("lock"))?;
        fs2::FileExt::lock_exclusive(&lock)?;
        let mut tokens = self.read()?;
        update(&mut tokens);
        let encoded = Zeroizing::new(serde_json::to_vec(&tokens).map_err(|_| io::Error::other("Could not encode Git tokens."))?);
        let encrypted = dpapi(&encoded, true)?;
        if encrypted.len() as u64 > MAX_BYTES {
            return Err(io::Error::other("Saved Git tokens exceed their size limit."));
        }
        let mut temp = atomic_file::new_in(dir)?;
        temp.write_all(&encrypted)?;
        temp.as_file().sync_all()?;
        atomic_file::replace(temp, &self.0)
    }

    pub fn save(&self, token: Token) -> io::Result<()> {
        self.write(|tokens| {
            tokens.retain(|old| old.key != token.key && old.expires.is_none_or(|expiry| expiry > now()));
            if tokens.len() >= LIMIT {
                tokens.remove(0);
            }
            tokens.push(token);
        })
    }

    pub fn erase(&self, key: &Key, password: Option<&str>) -> io::Result<()> {
        if !self.0.try_exists()? {
            return Ok(());
        }
        self.write(|tokens| tokens.retain(|token| !token.key.matches(key) || password.is_some_and(|value| value != token.password)))
    }

    pub fn forget(&self) -> io::Result<()> {
        if !self.0.try_exists()? {
            return Ok(());
        }
        let lock = OpenOptions::new().create(true).truncate(false).write(true).open(self.0.with_extension("lock"))?;
        fs2::FileExt::lock_exclusive(&lock)?;
        match fs::remove_file(&self.0) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        }
    }
}
