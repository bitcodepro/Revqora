use super::ToolError;
#[cfg(windows)]
use crate::windows_secret::dpapi;
use ring::{hmac, rand};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::fs::OpenOptions;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;
use zeroize::{Zeroize, Zeroizing};

pub(super) type Secret = Zeroizing<[u8; 32]>;
const REQUEST_MAX: usize = 128 * 1024;
const REPLY_MAX: usize = 2 * 1024 * 1024;
const AUTH_MAX: usize = 1024;
const AUTH_TIMEOUT: Duration = Duration::from_secs(5);
const REPLY_TIMEOUT: Duration = super::DISPATCH_TIMEOUT.saturating_add(Duration::from_secs(5));

fn nonce() -> io::Result<[u8; 32]> {
    rand::generate::<[u8; 32]>(&rand::SystemRandom::new()).map(rand::Random::expose).map_err(|_| io::Error::other("Secure randomness is unavailable."))
}

pub(super) fn secret() -> io::Result<Secret> {
    Ok(Zeroizing::new(nonce()?))
}

pub(super) fn random_id() -> io::Result<String> {
    Ok(nonce()?[..16].iter().map(|byte| format!("{byte:02x}")).collect())
}

#[derive(Serialize, Deserialize)]
struct Descriptor {
    port: u16,
    key: Vec<u8>,
}

pub(super) fn descriptor_path() -> io::Result<PathBuf> {
    Ok(crate::portable::runtime_dir()?.join("mcp-session.json"))
}

pub(super) fn publish(path: &Path, port: u16, key: &Secret) -> io::Result<()> {
    let mut file = crate::git::atomic_file::new_in(path.parent().ok_or_else(|| io::Error::other("Missing portable data folder."))?)?;
    let mut descriptor = Descriptor { port, key: protect(key.as_ref())? };
    let written = serde_json::to_writer(&mut file, &descriptor);
    descriptor.key.zeroize();
    written?;
    file.as_file().sync_all()?;
    crate::git::atomic_file::replace(file, path)
}

fn read_descriptor(path: &Path) -> io::Result<(u16, Secret)> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > 4096 {
        return Err(denied());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0 || metadata.uid() != unsafe { libc::geteuid() } {
            return Err(denied());
        }
    }
    let bytes = Zeroizing::new({
        let mut bytes = Vec::new();
        file.take(4097).read_to_end(&mut bytes)?;
        bytes
    });
    let descriptor: Descriptor = serde_json::from_slice(&bytes)?;
    let stored = Zeroizing::new(descriptor.key);
    let key = unprotect(&stored)?;
    let key = key.as_slice().try_into().map_err(|_| denied())?;
    if descriptor.port == 0 {
        return Err(denied());
    }
    Ok((descriptor.port, Zeroizing::new(key)))
}

#[cfg(unix)]
fn protect(key: &[u8]) -> io::Result<Vec<u8>> {
    Ok(key.to_vec())
}

#[cfg(unix)]
fn unprotect(key: &[u8]) -> io::Result<Zeroizing<Vec<u8>>> {
    Ok(Zeroizing::new(key.to_vec()))
}

#[cfg(windows)]
fn protect(key: &[u8]) -> io::Result<Vec<u8>> {
    Ok(dpapi(key, true)?.to_vec())
}

#[cfg(windows)]
fn unprotect(key: &[u8]) -> io::Result<Zeroizing<Vec<u8>>> {
    dpapi(key, false)
}

fn denied() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "The local MCP session could not be authenticated.")
}

pub(super) fn frame(reader: &mut impl BufRead, limit: usize) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    if reader.take((limit + 1) as u64).read_until(b'\n', &mut line)? == 0 {
        return Ok(None);
    }
    if line.len() > limit {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "MCP message exceeds the size limit."));
    }
    if line.last() != Some(&b'\n') {
        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "Incomplete MCP message."));
    }
    Ok(Some(line))
}

fn read<T: DeserializeOwned>(reader: &mut impl BufRead, limit: usize) -> io::Result<T> {
    let line = frame(reader, limit)?.ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "The local MCP connection closed."))?;
    Ok(serde_json::from_slice(&line)?)
}

pub(super) fn write(writer: &mut impl Write, value: &impl Serialize, limit: usize) -> io::Result<()> {
    let mut line = serde_json::to_vec(value)?;
    if line.len() >= limit {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "MCP reply exceeds the size limit."));
    }
    line.push(b'\n');
    writer.write_all(&line)?;
    writer.flush()
}

#[derive(Serialize, Deserialize)]
struct Hello {
    nonce: [u8; 32],
    tag: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
struct Packet {
    body: String,
    tag: Vec<u8>,
}

struct Auth {
    key: hmac::Key,
    client: [u8; 32],
    server: [u8; 32],
}

impl Auth {
    fn new(key: &Secret, client: [u8; 32], server: [u8; 32]) -> Self {
        Self { key: hmac::Key::new(hmac::HMAC_SHA256, key.as_ref()), client, server }
    }

    fn message(&self, role: &[u8], body: &[u8]) -> Vec<u8> {
        [b"revqora-mcp/1\0", role, &self.client, &self.server, body].concat()
    }

    fn tag(&self, role: &[u8], body: &[u8]) -> Vec<u8> {
        hmac::sign(&self.key, &self.message(role, body)).as_ref().to_vec()
    }

    fn verify(&self, role: &[u8], body: &[u8], tag: &[u8]) -> io::Result<()> {
        hmac::verify(&self.key, &self.message(role, body), tag).map_err(|_| denied())
    }

    fn send(&self, writer: &mut impl Write, role: &[u8], value: &impl Serialize, max: usize) -> io::Result<()> {
        let body = serde_json::to_string(value)?;
        write(writer, &Packet { tag: self.tag(role, body.as_bytes()), body }, max)
    }

    fn receive<T: DeserializeOwned>(&self, reader: &mut impl BufRead, role: &[u8], max: usize) -> io::Result<T> {
        let packet: Packet = read(reader, max)?;
        self.verify(role, packet.body.as_bytes(), &packet.tag)?;
        Ok(serde_json::from_str(&packet.body)?)
    }
}

pub(super) fn call(request: &impl Serialize) -> super::Reply {
    let (port, key) = descriptor_path().and_then(|path| read_descriptor(&path)).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => {
            if super::preference_path().is_ok_and(|path| super::saved_enabled(&path).unwrap_or_default()) {
                ToolError::desktop_closed()
            } else {
                ToolError::disabled()
            }
        }
        _ => authentication_failed(),
    })?;
    let socket = TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, port)), Duration::from_secs(3)).map_err(|error| match error.kind() {
        io::ErrorKind::ConnectionRefused => ToolError::desktop_closed(),
        _ => ToolError::new("desktop_unavailable", "Could not connect to Revqora's local MCP session. Check Settings → General → MCP."),
    })?;
    exchange(socket, &key, request, AUTH_TIMEOUT)
}

fn exchange(socket: TcpStream, key: &Secret, request: &impl Serialize, auth_timeout: Duration) -> super::Reply {
    let mut connection = BufReader::new(socket);
    let auth = (|| -> io::Result<Auth> {
        let socket = connection.get_mut();
        socket.set_read_timeout(Some(auth_timeout))?;
        socket.set_write_timeout(Some(auth_timeout))?;
        let client = nonce()?;
        write(socket, &client, AUTH_MAX)?;
        let hello: Hello = read(&mut connection, AUTH_MAX)?;
        let auth = Auth::new(key, client, hello.nonce);
        auth.verify(b"hello", &[], &hello.tag)?;
        Ok(auth)
    })()
    .map_err(|error| match error.kind() {
        io::ErrorKind::PermissionDenied | io::ErrorKind::InvalidData => authentication_failed(),
        _ => reply_error(error),
    })?;
    // Updating a different socket handle left the Windows reader with the
    // handshake timeout. Use the same connection throughout the exchange.
    connection.get_ref().set_read_timeout(Some(REPLY_TIMEOUT)).map_err(reply_error)?;
    auth.send(connection.get_mut(), b"request", request, REQUEST_MAX)
        .map_err(|_| ToolError::new("request_send_failed", "Could not send the MCP request to Revqora."))?;
    auth.receive(&mut connection, b"reply", REPLY_MAX).map_err(reply_error)?
}

fn authentication_failed() -> ToolError {
    ToolError::new("mcp_authentication_failed", "Could not authenticate the local MCP session. Check Settings → General → MCP.")
}

fn reply_error(error: io::Error) -> ToolError {
    match error.kind() {
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => ToolError::new("request_timeout", "Timed out waiting for Revqora's MCP reply."),
        io::ErrorKind::InvalidData | io::ErrorKind::PermissionDenied => {
            ToolError::new("invalid_desktop_reply", "Revqora returned an invalid or unauthenticated MCP reply.")
        }
        _ => ToolError::new("desktop_unavailable", "The local MCP connection closed before Revqora returned a result."),
    }
}

pub(super) fn serve(mut socket: TcpStream, key: &Secret, dispatch: impl FnOnce(Value) -> super::Reply) -> io::Result<()> {
    // Winsock can inherit the listener's nonblocking mode. The worker reads a
    // complete frame and relies on timeouts while the next bytes are in flight.
    socket.set_nonblocking(false)?;
    socket.set_read_timeout(Some(AUTH_TIMEOUT))?;
    socket.set_write_timeout(Some(AUTH_TIMEOUT))?;
    let mut reader = BufReader::new(socket.try_clone()?);
    let client = read(&mut reader, AUTH_MAX)?;
    let server = nonce()?;
    let auth = Auth::new(key, client, server);
    write(&mut socket, &Hello { nonce: server, tag: auth.tag(b"hello", &[]) }, AUTH_MAX)?;
    let request = auth.receive(&mut reader, b"request", REQUEST_MAX)?;
    let reply = dispatch(request);
    auth.send(&mut socket, b"reply", &reply, REPLY_MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authentication_binds_the_payload_to_both_nonces_and_the_direction() {
        let key = secret().unwrap();
        let auth = Auth::new(&key, [1; 32], [2; 32]);
        let message = b"{\"name\":\"list_repositories\"}";
        let tag = auth.tag(b"request", message);
        assert!(auth.verify(b"request", message, &tag).is_ok());
        assert!(auth.verify(b"request", b"{}", &tag).is_err());
        assert!(auth.verify(b"reply", message, &tag).is_err());
        assert!(Auth::new(&key, [3; 32], [2; 32]).verify(b"request", message, &tag).is_err());
        assert!(Auth::new(&key, [1; 32], [3; 32]).verify(b"request", message, &tag).is_err());
    }

    #[test]
    fn authenticated_replies_can_outlast_the_handshake_timeout() {
        let key = secret().unwrap();
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (server, _) = listener.accept().unwrap();
        let auth_timeout = Duration::from_secs(1);
        let request = serde_json::json!({ "name": "list_pull_requests" });
        let result = serde_json::json!({ "items": [{ "number": 12, "title": "Fix API calls" }] });
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                serve(server, &key, |received| {
                    assert_eq!(received, request);
                    std::thread::sleep(auth_timeout + Duration::from_millis(250));
                    Ok(result.clone())
                })
                .unwrap();
            });
            assert_eq!(exchange(client, &key, &request, auth_timeout), Ok(result.clone()));
            worker.join().unwrap();
        });
    }

    #[test]
    fn serves_a_split_handshake_from_a_nonblocking_socket() {
        let key = secret().unwrap();
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        client.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let (server, _) = listener.accept().unwrap();
        server.set_nonblocking(true).unwrap();

        std::thread::scope(|scope| {
            let exchange = scope.spawn(|| {
                let client_nonce = [7; 32];
                let frame = serde_json::to_vec(&client_nonce).unwrap();
                client.write_all(&frame[..1]).unwrap();
                std::thread::sleep(Duration::from_millis(50));
                client.write_all(&frame[1..]).unwrap();
                client.write_all(b"\n").unwrap();
                let mut reader = BufReader::new(client.try_clone().unwrap());
                let hello: Hello = read(&mut reader, AUTH_MAX).unwrap();
                let auth = Auth::new(&key, client_nonce, hello.nonce);
                auth.verify(b"hello", &[], &hello.tag).unwrap();
                auth.send(&mut client, b"request", &Value::Null, REQUEST_MAX).unwrap();
                let reply: super::super::Reply = auth.receive(&mut reader, b"reply", REPLY_MAX).unwrap();
                assert_eq!(reply, Ok(Value::Bool(true)));
            });
            serve(server, &key, |request| {
                assert_eq!(request, Value::Null);
                Ok(Value::Bool(true))
            })
            .unwrap();
            exchange.join().unwrap();
        });
    }
}
