//! Portable Git transport preferences. Secrets stay in askpass/agents/vaults;
//! only authentication choices and existing key/program paths are stored here.
use super::{
    atomic_file,
    runner::{GitError, GitResult},
};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Https {
    #[default]
    Auto,
    Token,
    Browser,
}
#[derive(Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Ssh {
    #[default]
    Auto,
    Agent,
    Key,
    Password,
}
#[derive(Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    #[serde(default)]
    pub https: Https,
    #[serde(default)]
    pub ssh: Ssh,
    #[serde(default)]
    pub private_key: String,
    #[serde(default)]
    pub ssh_program: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub options: Options,
    pub revision: String,
    pub credential_manager_configured: bool,
    pub can_remember_tokens: bool,
}
fn fail(message: impl Into<String>) -> GitError {
    GitError::new(message).kind("git-connection")
}
fn location(root: &Path) -> GitResult<PathBuf> {
    // Match Git's shared config and the API-account scope: linked worktrees
    // must keep the selected key/agent instead of silently falling back to Auto.
    // This resolver reads metadata directly and never recurses into the runner.
    let root = super::operations::repository_key(root);
    let mut text = root.to_string_lossy().into_owned();
    if cfg!(windows) {
        text.make_ascii_lowercase();
    }
    Ok(crate::portable::runtime_dir()?.join("git-connections").join(format!("{:x}.json", Sha256::digest(text.as_bytes()))))
}
fn read(root: &Path) -> GitResult<Snapshot> {
    let path = location(root)?;
    if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink() || !m.is_file()) {
        return Err(fail("Git connection settings must be a regular file."));
    }
    let bytes = match fs::File::open(path) {
        Ok(file) => {
            let mut bytes = vec![];
            file.take(32769).read_to_end(&mut bytes)?;
            bytes
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Snapshot {
                options: Options::default(),
                revision: "none".into(),
                credential_manager_configured: false,
                can_remember_tokens: cfg!(windows),
            })
        }
        Err(e) => return Err(e.into()),
    };
    if bytes.len() > 32768 {
        return Err(fail("Git connection settings exceed the size limit."));
    }
    let options = serde_json::from_slice(&bytes)
        .map_err(|_| fail("Git connection settings are damaged. Restore the file in portable data/git-connections before connecting."))?;
    Ok(Snapshot { options, revision: format!("{:x}", Sha256::digest(&bytes)), credential_manager_configured: false, can_remember_tokens: cfg!(windows) })
}
pub fn snapshot(root: &Path) -> GitResult<Snapshot> {
    let mut value = read(root)?;
    value.credential_manager_configured = manager_configured(root);
    Ok(value)
}
fn manager_configured(root: &Path) -> bool {
    let mut command = Command::new(super::locate::exe());
    command.current_dir(root).args(["config", "--get-all", "credential.helper"]).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.output().is_ok_and(|out| {
        let mut configured = false;
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let value = line.trim().trim_matches('"').replace('\\', "/");
            if value.is_empty() {
                configured = false;
            } else if matches!(
                value.rsplit('/').next(),
                Some(
                    "manager"
                        | "manager-core"
                        | "git-credential-manager"
                        | "git-credential-manager.exe"
                        | "git-credential-manager-core"
                        | "git-credential-manager-core.exe"
                )
            ) {
                configured = true;
            }
        }
        configured
    })
}
pub fn managed_ssh(root: &Path) -> GitResult<bool> {
    let options = read(root)?.options;
    Ok(options.ssh != Ssh::Auto || !options.ssh_program.is_empty())
}
pub fn finish(command: &mut Command) {
    let get = |key: &str| command.get_envs().find(|(k, _)| *k == key).and_then(|(_, v)| v).map(|s| s.to_string_lossy().into_owned());
    if get("SSH_ASKPASS_REQUIRE").as_deref() == Some("never") && get("GIT_SSH_VARIANT").as_deref() == Some("ssh") {
        if let Some(ssh) = get("GIT_SSH_COMMAND") {
            command.env("GIT_SSH_COMMAND", format!("{ssh} -o BatchMode=yes -o ConnectTimeout=20"));
        }
    }
}
fn file(path: &str, label: &str) -> GitResult<()> {
    if path.len() > 8192 || path.chars().any(char::is_control) || !Path::new(path).is_absolute() || !Path::new(path).is_file() {
        return Err(fail(format!("Choose an existing absolute {label} path.")));
    }
    Ok(())
}
pub fn validate(options: &Options) -> GitResult<()> {
    if options.ssh == Ssh::Key {
        file(&options.private_key, "private key")?;
        if options.private_key.to_lowercase().ends_with(".pub") {
            return Err(fail("Choose the private key, not its .pub public key."));
        }
    }
    if !options.ssh_program.is_empty() {
        file(&options.ssh_program, "OpenSSH program")?;
    }
    if options.private_key.len() > 8192 || options.private_key.chars().any(char::is_control) {
        return Err(fail("Invalid private key path."));
    }
    Ok(())
}
pub fn validate_for(root: &Path, options: &Options) -> GitResult<()> {
    validate(options)?;
    if options.https == Https::Browser && !manager_configured(root) {
        return Err(fail("Browser sign-in requires Git Credential Manager configured as a credential helper for this Git installation. Install/configure GCM or choose token authentication."));
    }
    Ok(())
}
pub fn save(root: &Path, options: Options, expected: &str) -> GitResult<Snapshot> {
    validate_for(root, &options)?;
    let path = location(root)?;
    let parent = path.parent().unwrap();
    fs::create_dir_all(parent)?;
    let lock = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(path.with_extension("lock"))?;
    lock.lock_exclusive()?;
    if read(root)?.revision != expected {
        return Err(fail("Git connection settings changed. Reload before saving.").kind("stale-operation"));
    }
    let mut temp = atomic_file::new_in(parent)?;
    serde_json::to_writer(&mut temp, &options).map_err(|_| fail("Could not serialize Git connection settings."))?;
    temp.flush()?;
    temp.as_file().sync_all()?;
    atomic_file::replace(temp, &path)?;
    snapshot(root)
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn shell_path(value: &str) -> String {
    if cfg!(windows) {
        value.replace('\\', "/")
    } else {
        value.into()
    }
}
pub fn apply(root: &Path, command: &mut Command, selected: Option<&Options>, args: &[String]) -> GitResult<()> {
    let mut index = 0;
    while args.get(index).is_some_and(|s| s == "-c" || s == "--literal-pathspecs") {
        index += if args[index] == "-c" { 2 } else { 1 };
    }
    let network = args.get(index).is_some_and(|s| matches!(s.as_str(), "fetch" | "push" | "clone" | "ls-remote"));
    if !network && !args.get(index).is_some_and(|s| s == "credential") {
        return Ok(());
    }
    // Azure organizations share a hostname. With Git's default useHttpPath=false,
    // askpass and helpers lose the organization and cannot safely select its
    // account. Match GCM's Azure policy, and preserve installation prefixes
    // for saved accounts (e.g. self-managed GitLab). Config is origin-specific
    // for this invocation only; other hosts/config files remain unchanged.
    let mut scoped = std::collections::BTreeSet::from(["https://dev.azure.com".to_owned()]);
    if let Ok(origins) = super::forge_accounts::manager().and_then(|m| m.git_path_origins()) {
        scoped.extend(origins);
    }
    for origin in scoped {
        command.args(["-c", &format!("credential.{origin}.useHttpPath=true")]);
    }
    let saved;
    let options = if let Some(selected) = selected {
        selected
    } else {
        saved = read(root)?;
        &saved.options
    };
    if options.https == Https::Browser {
        // Explicit opt-in; background/API callers override these variables back
        // to noninteractive after transport setup. No global Git config edits.
        command
            .env("GCM_INTERACTIVE", "auto")
            .env("GCM_GUI_PROMPT", "1")
            .env("GCM_GITHUB_AUTHMODES", "oauth")
            .env("GCM_GITLAB_AUTHMODES", "browser")
            .env("GCM_BITBUCKET_AUTHMODES", "oauth");
    } else if network && options.https == Https::Auto {
        // Git validates access on the transport request. GCM's profile probe
        // can reject an otherwise valid Bitbucket repository token.
        command.args(["-c", "credential.https://bitbucket.org.bitbucketValidateStoredCredentials=false"]);
    }
    if options.https == Https::Token {
        command.args(["-c", "credential.helper="]);
        if let Some((_, helper)) = crate::askpass::env().iter().find(|(key, _)| key == crate::git_credentials::HELPER_VAR) {
            command.args(["-c", &format!("credential.helper={helper}")]);
        }
    }
    if !network {
        return Ok(());
    }
    if options.ssh == Ssh::Auto && options.ssh_program.is_empty() {
        return Ok(());
    }
    for path in [&options.private_key, &options.ssh_program] {
        if path.len() > 8192 || path.chars().any(char::is_control) || !path.is_empty() && !Path::new(path).is_absolute() {
            return Err(fail("Invalid SSH key or executable path. Open Git connection settings to select an absolute path."));
        }
    }
    let directory = crate::portable::runtime_dir()?.join("ssh");
    fs::create_dir_all(&directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    }
    let known = directory.join("known_hosts");
    if fs::symlink_metadata(&known).is_ok_and(|m| m.file_type().is_symlink() || !m.is_file()) {
        return Err(fail("Portable known_hosts must be a regular file."));
    }
    let program = if options.ssh_program.is_empty() { "ssh" } else { &options.ssh_program };
    let mut args = vec![quote(&shell_path(program))];
    // Explicit managed modes have deterministic identity selection. Existing
    // aliases, proxies, certificates and custom clients remain in Auto mode.
    if options.ssh != Ssh::Auto {
        args.extend(["-F".into(), "none".into()]);
    }
    // OpenSSH expands environment values once, without reinterpreting '%' or
    // '${...}' inside the value. Keep filenames out of shell/config parsing.
    command.env("REVQORA_SSH_KNOWN_HOSTS", shell_path(&known.to_string_lossy()));
    args.extend(["-o".into(), quote("UserKnownHostsFile=${REVQORA_SSH_KNOWN_HOSTS}"), "-o".into(), "StrictHostKeyChecking=ask".into()]);
    match options.ssh {
        Ssh::Key => {
            command.env("REVQORA_SSH_IDENTITY", shell_path(&options.private_key));
            args.extend([
                "-o".into(),
                quote("IdentityFile=${REVQORA_SSH_IDENTITY}"),
                "-o".into(),
                "IdentitiesOnly=yes".into(),
                "-o".into(),
                "IdentityAgent=none".into(),
                "-o".into(),
                "PreferredAuthentications=publickey".into(),
            ]);
        }
        Ssh::Agent => args.extend(["-o".into(), "IdentityFile=none".into(), "-o".into(), "PreferredAuthentications=publickey".into()]),
        Ssh::Password => {
            args.extend(["-o".into(), "PubkeyAuthentication=no".into(), "-o".into(), "PreferredAuthentications=keyboard-interactive,password".into()])
        }
        Ssh::Auto => {}
    }
    command.env("GIT_SSH_COMMAND", args.join(" ")).env("GIT_SSH_VARIANT", "ssh");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::{ops, runner};
    fn root() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        runner::run(temp.path(), ["init", "-q"]).unwrap();
        temp
    }
    fn env(command: &Command, key: &str) -> Option<String> {
        command.get_envs().find(|(k, _)| *k == key).and_then(|(_, v)| v).map(|v| v.to_string_lossy().into_owned())
    }
    #[test]
    fn authentication_preferences_are_portable_revision_guarded_and_isolated_without_copying_private_keys() {
        let one = root();
        let two = root();
        let key = one.path().join("private key ' % ü");
        fs::write(&key, "PRIVATE MATERIAL MUST NOT BE COPIED").unwrap();
        let options = Options { ssh: Ssh::Key, private_key: key.to_string_lossy().into(), ..Default::default() };
        let before = snapshot(one.path()).unwrap();
        let saved = save(one.path(), options.clone(), &before.revision).unwrap();
        assert!(saved.options == options);
        assert!(snapshot(two.path()).unwrap().options == Options::default());
        assert!(location(one.path()).unwrap().starts_with(crate::portable::runtime_dir().unwrap()));
        assert!(!fs::read_to_string(location(one.path()).unwrap()).unwrap().contains("PRIVATE MATERIAL"));
        assert_eq!(save(one.path(), Options::default(), &before.revision).err().unwrap().kind, "stale-operation");
        let mut reader = fs::File::open(location(one.path()).unwrap()).unwrap();
        save(one.path(), Options::default(), &saved.revision).unwrap();
        let mut old = String::new();
        reader.read_to_string(&mut old).unwrap();
        assert!(serde_json::from_str::<Options>(&old).unwrap() == options);
    }
    #[test]
    fn recloning_with_explicit_defaults_replaces_the_previous_identity_at_that_path() {
        let source = root();
        runner::run(source.path(), ["config", "user.name", "Connection test"]).unwrap();
        runner::run(source.path(), ["config", "user.email", "connection@example.invalid"]).unwrap();
        runner::run(source.path(), ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "fixture"]).unwrap();
        let parent = tempfile::tempdir().unwrap();
        let key = parent.path().join("old private key");
        fs::write(&key, "fixture key path only").unwrap();
        let selected = Options { ssh: Ssh::Key, private_key: key.to_string_lossy().into(), ..Default::default() };
        let source_url = source.path().to_str().unwrap();
        let (destination, warning) = ops::clone_with_connection(parent.path(), source_url, "copy", |_| {}, Some(&selected)).unwrap();
        assert!(warning.is_none());
        assert!(snapshot(&destination).unwrap().options == selected);
        fs::remove_dir_all(&destination).unwrap();
        let (_, warning) = ops::clone_with_connection(parent.path(), source_url, "copy", |_| {}, Some(&Options::default())).unwrap();
        assert!(warning.is_none());
        assert!(snapshot(&destination).unwrap().options == Options::default());
        assert_eq!(runner::run(&destination, ["rev-parse", "HEAD"]).unwrap(), runner::run(source.path(), ["rev-parse", "HEAD"]).unwrap());
    }
    #[test]
    fn linked_worktrees_share_transport_choices_and_revision_guards() {
        let root = root();
        runner::run(root.path(), ["config", "user.name", "Connection test"]).unwrap();
        runner::run(root.path(), ["config", "user.email", "connection@example.invalid"]).unwrap();
        runner::run(root.path(), ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "fixture"]).unwrap();
        let linked = tempfile::tempdir().unwrap();
        let child = linked.path().join("working copy");
        runner::run(root.path(), ["worktree", "add", "-qb", "linked", child.to_str().unwrap()]).unwrap();
        let selected = Options { ssh: Ssh::Agent, ..Default::default() };
        let first = save(root.path(), selected.clone(), &snapshot(root.path()).unwrap().revision).unwrap();
        assert!(snapshot(&child).unwrap().options == selected);
        assert_eq!(snapshot(&child).unwrap().revision, first.revision);
        let password = Options { ssh: Ssh::Password, ..Default::default() };
        save(&child, password.clone(), &first.revision).unwrap();
        assert!(snapshot(root.path()).unwrap().options == password);
        assert_eq!(save(root.path(), selected, &first.revision).err().unwrap().kind, "stale-operation");
        let mut command = runner::command(&child);
        apply(&child, &mut command, None, &["fetch".into()]).unwrap();
        assert!(env(&command, "GIT_SSH_COMMAND").unwrap().contains("PubkeyAuthentication=no"));
    }
    #[test]
    fn managed_ssh_keeps_identity_and_host_trust_while_background_mode_disables_all_prompts() {
        let root = root();
        let key = root.path().join("key with ' quotes %");
        fs::write(&key, "fixture only").unwrap();
        let options = Options { ssh: Ssh::Key, private_key: key.to_string_lossy().into(), ..Default::default() };
        save(root.path(), options, &snapshot(root.path()).unwrap().revision).unwrap();
        let args = vec!["fetch".into(), "--all".into()];
        let mut command = runner::command(root.path());
        apply(root.path(), &mut command, None, &args).unwrap();
        for (k, v) in ops::background_env(managed_ssh(root.path()).unwrap()) {
            command.env(k, v);
        }
        finish(&mut command);
        let ssh = env(&command, "GIT_SSH_COMMAND").unwrap();
        assert!(ssh.contains("IdentityAgent=none") && ssh.contains("IdentitiesOnly=yes") && ssh.contains("StrictHostKeyChecking=ask"));
        assert!(ssh.contains("BatchMode=yes") && ssh.contains("REVQORA_SSH_KNOWN_HOSTS"));
        assert_eq!(env(&command, "REVQORA_SSH_IDENTITY").as_deref(), Some(shell_path(&key.to_string_lossy()).as_str()));
        assert_eq!(env(&command, "GCM_INTERACTIVE").as_deref(), Some("never"));
        assert!(!ssh.contains("StrictHostKeyChecking=no"));
        fs::remove_file(key).unwrap();
        assert!(runner::run(root.path(), ["status", "--porcelain"]).is_ok(), "A missing SSH key must not disable local Git operations");
    }
    #[test]
    fn browser_sign_in_is_explicit_configured_and_overridden_for_unattended_fetch() {
        let root = root();
        runner::run(root.path(), ["config", "credential.helper", ""]).unwrap();
        let options = Options { https: Https::Browser, ..Default::default() };
        assert!(save(root.path(), options.clone(), &snapshot(root.path()).unwrap().revision).is_err());
        runner::run(root.path(), ["config", "--add", "credential.helper", "manager"]).unwrap();
        save(root.path(), options, &snapshot(root.path()).unwrap().revision).unwrap();
        let args = vec!["fetch".into()];
        let mut command = runner::command(root.path());
        apply(root.path(), &mut command, None, &args).unwrap();
        assert_eq!(env(&command, "GCM_INTERACTIVE").as_deref(), Some("auto"));
        for (k, v) in ops::background_env(false) {
            command.env(k, v);
        }
        finish(&mut command);
        assert_eq!(env(&command, "GCM_INTERACTIVE").as_deref(), Some("never"));
        assert_eq!(env(&command, "SSH_ASKPASS_REQUIRE").as_deref(), Some("never"));
        runner::run(root.path(), ["config", "--add", "credential.helper", ""]).unwrap();
        assert!(!snapshot(root.path()).unwrap().credential_manager_configured);
    }
    #[test]
    fn automatic_fetch_uses_the_saved_bitbucket_credential_without_a_profile_probe() {
        let root = root();
        let mut command = runner::command(root.path());
        apply(root.path(), &mut command, Some(&Options::default()), &["fetch".into()]).unwrap();
        assert!(command.get_args().any(|arg| arg == "credential.https://bitbucket.org.bitbucketValidateStoredCredentials=false"));
        let mut command = runner::command(root.path());
        apply(root.path(), &mut command, Some(&Options::default()), &["status".into()]).unwrap();
        assert!(!command.get_args().any(|arg| arg == "credential.https://bitbucket.org.bitbucketValidateStoredCredentials=false"));
    }
    #[test]
    fn corrupt_auth_preferences_fail_network_operations_without_disabling_local_git_or_overwriting_settings() {
        let root = root();
        let path = location(root.path()).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "damaged").unwrap();
        assert!(runner::run(root.path(), ["status", "--porcelain"]).is_ok());
        let mut command = runner::command(root.path());
        assert!(apply(root.path(), &mut command, None, &["fetch".into()]).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "damaged");
    }
}
