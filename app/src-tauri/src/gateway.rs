//! ModelGateway — the only component that opens network connections to model
//! servers.
//!
//! Deep module: the rest of the app cannot tell the Ollama and
//! OpenAI-compatible dialects apart. Surface:
//!
//! - [`Gateway::list_models`] — model ids for the picker (3 s total timeout)
//! - [`Gateway::chat`] — streamed completion, delivering [`ChatEvent`]s as
//!   they arrive; abortable via [`AbortFlag`]
//!
//! `chat` returns `Err` only for failures *before* the first byte (bad URL,
//! connect failure, HTTP error status). A connection lost mid-stream ends the
//! stream: whatever arrived is returned in the outcome with
//! [`ChatOutcome::error`] set, so callers can persist the partial content.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};

use crate::store::ServerKind;

/// Budget for reachability checks — a dead host must answer "no" fast.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone)]
pub struct Endpoint {
    pub kind: ServerKind,
    pub base_url: String,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelInfo {
    pub id: String,
}

/// One message handed to a model: role, text, optional image attachments
/// (data URLs or bare base64).
#[derive(Debug, Clone)]
pub struct ChatTurn {
    pub role: String,
    pub content: String,
    pub images: Vec<String>,
}

/// Per-request options. Fields the dialect has no equivalent for are ignored
/// inside the gateway — invisible from outside.
#[derive(Debug, Clone, Default)]
pub struct ChatOptions {
    pub system_prompt: Option<String>,
    pub temperature: Option<f64>,
    pub context_len: Option<i64>,
    pub thinking: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatEvent {
    Thinking { text: String },
    Content { text: String },
}

/// Final state of one streamed completion, including aborts and mid-stream
/// failures (partial content is preserved in both cases).
#[derive(Debug, Clone, Default)]
pub struct ChatOutcome {
    pub content: String,
    pub thinking: String,
    pub aborted: bool,
    pub error: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum GatewayError {
    #[error("Invalid server URL: {0}")]
    InvalidUrl(String),
    #[error("Connection failed: {0}")]
    Connect(String),
    #[error("Timed out after 3 s — the server did not respond")]
    Timeout,
    #[error("Server answered HTTP {status}: {body}")]
    Http { status: u16, body: String },
    #[error("Unexpected response from server: {0}")]
    Protocol(String),
}

/// Shared stop signal for an in-flight generation.
#[derive(Clone, Default)]
pub struct AbortFlag(Arc<AtomicBool>);

impl AbortFlag {
    pub fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }

    pub fn abort(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_aborted(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

pub struct Gateway {
    http: reqwest::Client,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Dialect {
    Ollama,
    OpenAi,
}

impl Gateway {
    pub fn new() -> Result<Self, GatewayError> {
        let http = reqwest::Client::builder()
            .connect_timeout(PROBE_TIMEOUT)
            .build()
            .map_err(|e| GatewayError::Connect(e.to_string()))?;
        Ok(Self { http })
    }

    /// Lists the models a server exposes. Doubles as the connection test:
    /// success proves reachability, dialect endpoints and (for keyed servers)
    /// auth all at once.
    pub async fn list_models(&self, endpoint: &Endpoint) -> Result<Vec<ModelInfo>, GatewayError> {
        let base = api_base(&endpoint.base_url, endpoint.kind)?;
        let url = match endpoint.kind {
            ServerKind::Ollama => format!("{base}/tags"),
            ServerKind::OpenAiCompatible => format!("{base}/models"),
        };

        let response = self
            .request(endpoint, reqwest::Method::GET, url)
            .timeout(PROBE_TIMEOUT)
            .send()
            .await
            .map_err(map_request_error)?;
        let value = parse_json_response(response).await?;

        let ids: Vec<String> = match endpoint.kind {
            ServerKind::Ollama => value
                .get("models")
                .and_then(Value::as_array)
                .ok_or_else(|| GatewayError::Protocol("missing `models` array".into()))?
                .iter()
                .filter_map(|m| m.get("name").and_then(Value::as_str))
                .map(str::to_string)
                .collect(),
            ServerKind::OpenAiCompatible => value
                .get("data")
                .and_then(Value::as_array)
                .ok_or_else(|| GatewayError::Protocol("missing `data` array".into()))?
                .iter()
                .filter_map(|m| m.get("id").and_then(Value::as_str))
                .map(str::to_string)
                .collect(),
        };

        if ids.is_empty() {
            return Err(GatewayError::Protocol("server listed no models".into()));
        }
        Ok(ids
            .into_iter()
            .map(|id| ModelInfo { id })
            .collect())
    }

    /// Streams a chat completion. `on_event` fires per delta; the returned
    /// outcome accumulates the same text. See the module docs for the
    /// error/partial contract.
    pub async fn chat(
        &self,
        endpoint: &Endpoint,
        model: &str,
        turns: &[ChatTurn],
        options: &ChatOptions,
        abort: &AbortFlag,
        mut on_event: impl FnMut(ChatEvent),
    ) -> Result<ChatOutcome, GatewayError> {
        let base = api_base(&endpoint.base_url, endpoint.kind)?;
        let (payload, url, dialect) = match endpoint.kind {
            ServerKind::Ollama => (
                ollama_payload(model, turns, options),
                format!("{base}/chat"),
                Dialect::Ollama,
            ),
            ServerKind::OpenAiCompatible => (
                openai_payload(model, turns, options),
                format!("{base}/chat/completions"),
                Dialect::OpenAi,
            ),
        };

        let response = self
            .request(endpoint, reqwest::Method::POST, url)
            .json(&payload)
            .send()
            .await
            .map_err(map_request_error)?;
        if !response.status().is_success() {
            return Err(http_error(response).await);
        }

        let mut stream = response.bytes_stream();
        let mut buffer: Vec<u8> = Vec::new();
        let mut outcome = ChatOutcome::default();

        loop {
            if abort.is_aborted() {
                outcome.aborted = true;
                return Ok(outcome);
            }

            // The select keeps aborts responsive even when the server stalls
            // mid-stream: at most ~150 ms pass between flag check rounds.
            let chunk = tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(150)) => continue,
                item = stream.next() => match item {
                    Some(Ok(bytes)) => bytes,
                    Some(Err(err)) => {
                        if abort.is_aborted() {
                            outcome.aborted = true;
                            return Ok(outcome);
                        }
                        outcome.error = Some(format!("connection lost mid-stream: {err}"));
                        return Ok(outcome);
                    }
                    None => break,
                },
            };

            buffer.extend_from_slice(&chunk);
            while let Some(newline) = buffer.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = buffer.drain(..=newline).collect();
                let line = String::from_utf8_lossy(&line[..line.len() - 1]);
                for event in parse_stream_line(line.trim(), dialect)? {
                    match &event {
                        ChatEvent::Content { text } => outcome.content.push_str(text),
                        ChatEvent::Thinking { text } => outcome.thinking.push_str(text),
                    }
                    on_event(event);
                }
            }
        }

        Ok(outcome)
    }

    fn request(
        &self,
        endpoint: &Endpoint,
        method: reqwest::Method,
        url: String,
    ) -> reqwest::RequestBuilder {
        let mut request = self.http.request(method, url);
        // Per the product contract only keyed OpenAI-compatible servers
        // authenticate; the key travels as a Bearer header.
        if endpoint.kind == ServerKind::OpenAiCompatible {
            if let Some(key) = endpoint.api_key.as_deref().filter(|k| !k.is_empty()) {
                request = request.bearer_auth(key);
            }
        }
        request
    }
}

/// Normalizes a user-entered base URL and appends the dialect's API root:
/// Ollama → `<base>/api`, OpenAI-compatible → `<base>/v1` — unless the user
/// already included an API root (`/v1`, or `/api` for Open WebUI-style
/// servers), in which case the base is used as-is.
fn api_base(base_url: &str, kind: ServerKind) -> Result<String, GatewayError> {
    let trimmed = base_url.trim().trim_end_matches('/');
    let url = reqwest::Url::parse(trimmed).map_err(|_| GatewayError::InvalidUrl(base_url.into()))?;
    if url.host_str().is_none() || (url.scheme() != "http" && url.scheme() != "https") {
        return Err(GatewayError::InvalidUrl(base_url.into()));
    }
    match kind {
        ServerKind::Ollama => Ok(format!("{trimmed}/api")),
        ServerKind::OpenAiCompatible
            if trimmed.ends_with("/v1") || trimmed.ends_with("/api") =>
        {
            Ok(trimmed.to_string())
        }
        ServerKind::OpenAiCompatible => Ok(format!("{trimmed}/v1")),
    }
}

fn map_request_error(error: reqwest::Error) -> GatewayError {
    if error.is_timeout() {
        GatewayError::Timeout
    } else if error.is_connect() {
        GatewayError::Connect(shorten(&error.to_string()))
    } else {
        GatewayError::Connect(shorten(&error.to_string()))
    }
}

async fn parse_json_response(
    response: reqwest::Response,
) -> Result<Value, GatewayError> {
    if !response.status().is_success() {
        return Err(http_error(response).await);
    }
    let value: Value = response
        .json()
        .await
        .map_err(|e| GatewayError::Protocol(format!("response is not JSON: {}", shorten(&e.to_string()))))?;
    Ok(value)
}

async fn http_error(response: reqwest::Response) -> GatewayError {
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    GatewayError::Http {
        status,
        body: shorten(&body),
    }
}

/// Error bodies arrive verbatim from foreign servers — cap them so UI toasts
/// stay readable.
fn shorten(text: &str) -> String {
    const MAX: usize = 200;
    if text.chars().count() <= MAX {
        text.to_string()
    } else {
        let cut: String = text.chars().take(MAX).collect();
        format!("{cut}…")
    }
}

/// Strips a `data:image/...;base64,` prefix — Ollama wants bare base64.
fn bare_base64(image: &str) -> String {
    if let Some(rest) = image.strip_prefix("data:") {
        if let Some(comma) = rest.find(',') {
            return rest[comma + 1..].to_string();
        }
    }
    image.to_string()
}

fn ollama_payload(model: &str, turns: &[ChatTurn], options: &ChatOptions) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    if let Some(system) = options
        .system_prompt
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        messages.push(json!({ "role": "system", "content": system }));
    }
    for turn in turns {
        let mut message = json!({ "role": turn.role, "content": turn.content });
        if !turn.images.is_empty() {
            message["images"] = json!(turn
                .images
                .iter()
                .map(|image| bare_base64(image))
                .collect::<Vec<_>>());
        }
        messages.push(message);
    }

    let mut payload = json!({ "model": model, "messages": messages, "stream": true });
    if options.thinking {
        payload["think"] = json!(true);
    }
    let mut tune = serde_json::Map::new();
    if let Some(temperature) = options.temperature {
        tune.insert("temperature".into(), json!(temperature));
    }
    if let Some(context_len) = options.context_len {
        tune.insert("num_ctx".into(), json!(context_len));
    }
    if !tune.is_empty() {
        payload["options"] = Value::Object(tune);
    }
    payload
}

fn openai_payload(model: &str, turns: &[ChatTurn], options: &ChatOptions) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    if let Some(system) = options
        .system_prompt
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        messages.push(json!({ "role": "system", "content": system }));
    }
    for turn in turns {
        if turn.images.is_empty() {
            messages.push(json!({ "role": turn.role, "content": turn.content }));
        } else {
            // Vision shape: text + image_url parts. The data URL travels as-is.
            let mut parts = Vec::new();
            if !turn.content.is_empty() {
                parts.push(json!({ "type": "text", "text": turn.content }));
            }
            for image in &turn.images {
                parts.push(json!({ "type": "image_url", "image_url": { "url": image } }));
            }
            messages.push(json!({ "role": turn.role, "content": parts }));
        }
    }

    let mut payload = json!({ "model": model, "messages": messages, "stream": true });
    if let Some(temperature) = options.temperature {
        payload["temperature"] = json!(temperature);
    }
    payload
}

/// Parses one line of a stream into 0–2 events (a single Ollama line may
/// carry thinking and content together).
fn parse_stream_line(line: &str, dialect: Dialect) -> Result<Vec<ChatEvent>, GatewayError> {
    let payload = match dialect {
        Dialect::Ollama => line,
        Dialect::OpenAi => {
            let trimmed = line.trim();
            if !trimmed.starts_with("data:") {
                return Ok(Vec::new());
            }
            let data = trimmed["data:".len()..].trim();
            if data == "[DONE]" {
                return Ok(Vec::new());
            }
            data
        }
    };
    if payload.is_empty() {
        return Ok(Vec::new());
    }

    let value: Value = serde_json::from_str(payload)
        .map_err(|e| GatewayError::Protocol(format!("bad stream chunk: {}", shorten(&e.to_string()))))?;

    if let Some(error) = value.get("error") {
        return Err(GatewayError::Protocol(format!(
            "server reported an error: {}",
            match error {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            }
        )));
    }

    let mut events = Vec::new();
    match dialect {
        Dialect::Ollama => {
            if value.get("done").and_then(Value::as_bool) == Some(true) {
                return Ok(events);
            }
            let message = &value["message"];
            if let Some(text) = message.get("thinking").and_then(Value::as_str) {
                if !text.is_empty() {
                    events.push(ChatEvent::Thinking { text: text.into() });
                }
            }
            if let Some(text) = message.get("content").and_then(Value::as_str) {
                if !text.is_empty() {
                    events.push(ChatEvent::Content { text: text.into() });
                }
            }
        }
        Dialect::OpenAi => {
            let delta = &value["choices"][0]["delta"];
            if let Some(text) = delta.get("reasoning_content").and_then(Value::as_str) {
                if !text.is_empty() {
                    events.push(ChatEvent::Thinking { text: text.into() });
                }
            }
            if let Some(text) = delta.get("content").and_then(Value::as_str) {
                if !text.is_empty() {
                    events.push(ChatEvent::Content { text: text.into() });
                }
            }
        }
    }
    Ok(events)
}
