//! Minimal hand-rolled HTTP mock server for ModelGateway integration tests.
//!
//! Lives on a plain `TcpListener` on an ephemeral localhost port. Requests are
//! captured (method, path, headers, body) so tests can assert on Bearer
//! headers and JSON payloads; responses are either a full body or chunked
//! pieces written with pauses, which simulates token streaming without any
//! extra dependency.

// Shared across several test binaries that each use a different subset.
#![allow(dead_code)]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone)]
pub struct CapturedRequest {
    pub method: String,
    pub path: String,
    /// Header names lowercased.
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl CapturedRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body).expect("captured request body should be JSON")
    }
}

pub enum Body {
    Full(String),
    /// Pieces written in order with a pause (ms) before each — token streaming.
    Chunks(Vec<(String, u64)>),
    /// Accepts the connection and never answers — drives timeout paths.
    Stall,
}

pub struct MockResponse {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Body,
}

impl MockResponse {
    pub fn json(body: impl Into<String>) -> Self {
        Self {
            status: 200,
            content_type: "application/json",
            body: Body::Full(body.into()),
        }
    }

    pub fn with_status(mut self, status: u16) -> Self {
        self.status = status;
        self
    }

    pub fn stream(content_type: &'static str, chunks: Vec<(String, u64)>) -> Self {
        Self {
            status: 200,
            content_type,
            body: Body::Chunks(chunks),
        }
    }

    pub fn stall() -> Self {
        Self {
            status: 200,
            content_type: "text/plain",
            body: Body::Stall,
        }
    }
}

pub struct MockServer {
    base_url: String,
    requests: Arc<Mutex<Vec<CapturedRequest>>>,
    shutdown: Sender<()>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl MockServer {
    pub fn start(handler: impl Fn(&CapturedRequest) -> MockResponse + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("mock server should bind");
        let port = listener.local_addr().expect("local addr").port();
        let requests: Arc<Mutex<Vec<CapturedRequest>>> = Arc::new(Mutex::new(Vec::new()));
        let (shutdown, shutdown_rx) = channel::<()>();
        let captured = requests.clone();

        let handle = std::thread::spawn(move || {
            listener
                .set_nonblocking(true)
                .expect("listener should go non-blocking");
            loop {
                if shutdown_rx.recv_timeout(Duration::from_millis(50)).is_ok() {
                    break;
                }
                match listener.accept() {
                    Ok((stream, _)) => serve(stream, &handler, &captured),
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock =>
                    {
                        continue;
                    }
                    Err(_) => break,
                }
            }
        });

        Self {
            base_url: format!("http://127.0.0.1:{port}"),
            requests,
            shutdown,
            handle: Some(handle),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn requests(&self) -> Vec<CapturedRequest> {
        self.requests.lock().expect("requests lock").clone()
    }

    pub fn last_request(&self) -> CapturedRequest {
        self.requests
            .lock()
            .expect("requests lock")
            .last()
            .cloned()
            .expect("at least one request should have been captured")
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        let _ = self.shutdown.send(());
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn serve(
    mut stream: std::net::TcpStream,
    handler: &dyn Fn(&CapturedRequest) -> MockResponse,
    captured: &Mutex<Vec<CapturedRequest>>,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let Some(request) = read_request(&mut stream) else {
        return;
    };
    captured.lock().expect("requests lock").push(request.clone());
    write_response(&mut stream, &handler(&request));
}

fn read_request(stream: &mut std::net::TcpStream) -> Option<CapturedRequest> {
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];

    let header_end = loop {
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(position) = find(&buffer, b"\r\n\r\n") {
            break position + 4;
        }
    };

    let head = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = head.split("\r\n");
    let request_line = lines.next()?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();

    let mut headers: Vec<(String, String)> = Vec::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }
    let content_length: usize = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse().ok())
        .unwrap_or(0);

    let mut body = buffer[header_end..].to_vec();
    while body.len() < content_length {
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(content_length);

    Some(CapturedRequest {
        method,
        path,
        headers,
        body: String::from_utf8_lossy(&body).to_string(),
    })
}

fn write_response(stream: &mut std::net::TcpStream, response: &MockResponse) {
    match &response.body {
        Body::Stall => {
            // Outlast the client's 10 s probe timeout; it must give up first.
            std::thread::sleep(Duration::from_secs(11));
        }
        Body::Full(text) => {
            let head = format!(
                "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response.status,
                reason(response.status),
                response.content_type,
                text.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(text.as_bytes());
            let _ = stream.flush();
        }
        Body::Chunks(chunks) => {
            // Content-Length covers the whole body; the client reads it
            // incrementally, which is what makes the pauses visible.
            let total: usize = chunks.iter().map(|(text, _)| text.len()).sum();
            let head = format!(
                "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response.status,
                reason(response.status),
                response.content_type,
                total
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.flush();
            for (text, delay_ms) in chunks {
                if *delay_ms > 0 {
                    std::thread::sleep(Duration::from_millis(*delay_ms));
                }
                // A write error here means the client aborted — stop cleanly.
                if stream.write_all(text.as_bytes()).is_err() {
                    break;
                }
                let _ = stream.flush();
            }
        }
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        401 => "Unauthorized",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "Unknown",
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}
